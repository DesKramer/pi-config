import { CONFIG_DIR_NAME, getPackageDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

type ResourceKind = "skills" | "prompts" | "extensions" | "mcps";

type ResourceItem = {
	kind: ResourceKind;
	path: string;
	label: string;
	description: string;
};

type CwdSelection = Record<ResourceKind, string[]>;
type SelectionFile = Record<string, CwdSelection>;

const EMPTY_SELECTION: CwdSelection = { skills: [], prompts: [], extensions: [], mcps: [] };
const STATE_PATH = join(tmpdir(), `pi-ephemeral-${process.pid}.json`);

function readState(): SelectionFile {
	try {
		return JSON.parse(readFileSync(STATE_PATH, "utf8")) as SelectionFile;
	} catch {
		return {};
	}
}

function writeState(state: SelectionFile): void {
	writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function getSelection(cwd: string): CwdSelection {
	const raw = readState()[cwd];
	return {
		skills: raw?.skills ?? [],
		prompts: raw?.prompts ?? [],
		extensions: raw?.extensions ?? [],
		mcps: raw?.mcps ?? [],
	};
}

function setSelection(cwd: string, selection: CwdSelection): void {
	const state = readState();
	const availableMcps = new Set(discoverMcps(cwd).map((item) => item.path));
	state[cwd] = {
		skills: [...new Set(selection.skills)].filter(existsSync),
		prompts: [...new Set(selection.prompts)].filter(existsSync),
		extensions: [...new Set(selection.extensions)].filter(existsSync),
		mcps: [...new Set(selection.mcps)].filter((name) => availableMcps.has(name)),
	};
	writeState(state);
}

function toggle(values: string[], value: string): string[] {
	return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function frontmatterValue(content: string, key: string): string | undefined {
	if (!content.startsWith("---")) return undefined;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return undefined;
	const lines = content.slice(3, end).split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(new RegExp(`^${key}:\\s*(.*)$`));
		if (!match) continue;
		const raw = match[1].trim();
		if (raw === ">" || raw === "|") {
			const nested: string[] = [];
			for (let j = i + 1; j < lines.length; j++) {
				const line = lines[j];
				if (/^[A-Za-z0-9_-]+:\s*/.test(line)) break;
				if (line.trim()) nested.push(line.trim());
			}
			return raw === "|" ? nested.join("\n") : nested.join(" ");
		}
		return raw.replace(/^['\"]|['\"]$/g, "");
	}
	return undefined;
}

function firstTextLine(content: string): string | undefined {
	return stripFrontmatter(content)
		.split(/\r?\n/)
		.map((line) => line.trim().replace(/^#+\s*/, ""))
		.find(Boolean);
}

function readSummary(path: string): { name?: string; description?: string } {
	try {
		const content = readFileSync(path, "utf8");
		return {
			name: frontmatterValue(content, "name"),
			description: frontmatterValue(content, "description") ?? firstTextLine(content),
		};
	} catch {
		return {};
	}
}

function listDir(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => !entry.name.startsWith("."))
			.map((entry) => join(dir, entry.name));
	} catch {
		return [];
	}
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

function readGlobalSettings(): Record<string, unknown> {
	return readJsonObject(join(getAgentDir(), "settings.json")) ?? {};
}

function isSkillFile(path: string): boolean {
	return path.endsWith(".md");
}

function findSkillEntries(root: string, includeRootMarkdown: boolean): string[] {
	if (!existsSync(root)) return [];
	if (isSkillFile(root)) return [root];
	if (existsSync(join(root, "SKILL.md"))) return [root];

	const entries: string[] = [];
	for (const entry of listDir(root)) {
		if (isSkillFile(entry)) {
			if (includeRootMarkdown) entries.push(entry);
			continue;
		}
		entries.push(...findSkillEntries(entry, true));
	}
	return entries;
}

function addSkillItems(items: Map<string, ResourceItem>, root: string, sourceLabel: string, includeRootMarkdown = true): void {
	for (const entry of findSkillEntries(expandHome(root), includeRootMarkdown)) {
		const skillFile = existsSync(join(entry, "SKILL.md")) ? join(entry, "SKILL.md") : entry;
		const summary = readSummary(skillFile);
		if (!summary.description) continue;
		const label = summary.name ?? basename(entry).replace(/\.md$/, "");
		items.set(skillFile, {
			kind: "skills",
			path: entry,
			label,
			description: `${summary.description} (${sourceLabel})`,
		});
	}
}

function packageDirs(root: string): string[] {
	const dirs: string[] = [];
	for (const entry of listDir(root)) {
		if (basename(entry).startsWith("@")) {
			dirs.push(...listDir(entry));
		} else {
			dirs.push(entry);
		}
	}
	return dirs;
}

function addPackageSkills(items: Map<string, ResourceItem>, packageRoot: string, sourceLabel: string): void {
	for (const pkgDir of packageDirs(packageRoot)) {
		const manifest = readJsonObject(join(pkgDir, "package.json"));
		if (!manifest) continue;
		const piManifest = manifest.pi && typeof manifest.pi === "object" && !Array.isArray(manifest.pi) ? manifest.pi as Record<string, unknown> : undefined;
		const declared = Array.isArray(piManifest?.skills) ? piManifest.skills.filter((value): value is string => typeof value === "string") : [];
		const skillRoots = declared.length > 0 ? declared.map((value) => join(pkgDir, value)) : [join(pkgDir, "skills")];
		for (const skillRoot of skillRoots) addSkillItems(items, skillRoot, `${sourceLabel}:${String(manifest.name ?? basename(pkgDir))}`);
	}
}

function discoverSkills(cwd: string): ResourceItem[] {
	const items = new Map<string, ResourceItem>();
	const settings = readGlobalSettings();
	const configured = Array.isArray(settings.skills) ? settings.skills.filter((value): value is string => typeof value === "string") : [];

	addSkillItems(items, join(getAgentDir(), "skills"), "Pi global");
	addSkillItems(items, join(homedir(), ".agents", "skills"), "global agents", false);
	for (const skillPath of configured) addSkillItems(items, skillPath, "settings");
	addPackageSkills(items, join(getAgentDir(), "npm", "node_modules"), "npm");
	addPackageSkills(items, join(getAgentDir(), "git"), "git");

	// Keep supporting project-local scratch skills as an extra source.
	addSkillItems(items, join(cwd, CONFIG_DIR_NAME, "ephemeral", "skills"), "project ephemeral");

	return [...items.values()];
}

type McpServerEntry = {
	command?: string;
	args?: string[];
	url?: string;
	description?: string;
};

const MCP_IMPORT_PATHS: Record<string, string[]> = {
	cursor: [join(homedir(), ".cursor", "mcp.json")],
	"claude-code": [
		join(homedir(), ".claude", "mcp.json"),
		join(homedir(), ".claude.json"),
		join(homedir(), ".claude", "claude_desktop_config.json"),
	],
	"claude-desktop": [join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")],
	codex: [join(homedir(), ".codex", "config.json")],
	windsurf: [join(homedir(), ".windsurf", "mcp.json")],
	vscode: [".vscode/mcp.json"],
};

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), CONFIG_DIR_NAME, "agent");
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function extractMcpServers(raw: Record<string, unknown> | undefined): Record<string, McpServerEntry> {
	const servers = raw?.mcpServers ?? raw?.["mcp-servers"];
	return servers && typeof servers === "object" && !Array.isArray(servers) ? servers as Record<string, McpServerEntry> : {};
}

function resolveMcpImportPath(kind: string, cwd: string): string | undefined {
	for (const candidate of MCP_IMPORT_PATHS[kind] ?? []) {
		const fullPath = candidate.startsWith(".") ? join(cwd, candidate) : candidate;
		if (existsSync(fullPath)) return fullPath;
	}
	return undefined;
}

function addMcpServersFromConfig(
	items: Map<string, ResourceItem>,
	configPath: string,
	sourceLabel: string,
	cwd: string,
): void {
	const raw = readJsonObject(configPath);
	if (!raw) return;

	const imports = Array.isArray(raw.imports) ? raw.imports.filter((value): value is string => typeof value === "string") : [];
	for (const importKind of imports) {
		const importPath = resolveMcpImportPath(importKind, cwd);
		if (importPath) addMcpServersFromConfig(items, importPath, `${sourceLabel} import:${importKind}`, cwd);
	}

	for (const [name, entry] of Object.entries(extractMcpServers(raw))) {
		const url = typeof entry.url === "string" ? entry.url : undefined;
		const command = typeof entry.command === "string" ? entry.command : undefined;
		const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
		const target = url ?? [command, ...args].filter(Boolean).join(" ");
		const description = typeof entry.description === "string" ? entry.description : undefined;
		items.set(name, {
			kind: "mcps",
			path: name,
			label: name,
			description: description ?? (target ? `${target} (${sourceLabel})` : sourceLabel),
		});
	}
}

function discoverMcps(cwd: string): ResourceItem[] {
	const items = new Map<string, ResourceItem>();
	const sources = [
		{ path: join(homedir(), ".config", "mcp", "mcp.json"), label: "standard MCP" },
		{ path: join(homedir(), ".cosine", "mcp.json"), label: "Cosine MCP" },
		{ path: join(getAgentDir(), "mcp.json"), label: "Pi MCP" },
		{ path: join(cwd, ".mcp.json"), label: "project MCP" },
		{ path: join(cwd, CONFIG_DIR_NAME, "mcp.json"), label: "project Pi MCP" },
	];
	const seenPaths = new Set<string>();
	for (const source of sources) {
		if (seenPaths.has(source.path)) continue;
		seenPaths.add(source.path);
		addMcpServersFromConfig(items, source.path, source.label, cwd);
	}
	return [...items.values()];
}

function isExtensionFile(path: string): boolean {
	return /\.(ts|js|mjs|cjs)$/.test(path);
}

function findExtensionEntry(dir: string): string | undefined {
	for (const name of ["index.ts", "index.js", "index.mjs", "index.cjs"]) {
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function discover(cwd: string): ResourceItem[] {
	const root = join(cwd, CONFIG_DIR_NAME, "ephemeral");
	const items: ResourceItem[] = [];

	items.push(...discoverSkills(cwd));

	for (const entry of listDir(join(root, "prompts"))) {
		if (!entry.endsWith(".md")) continue;
		const summary = readSummary(entry);
		items.push({
			kind: "prompts",
			path: entry,
			label: basename(entry, ".md"),
			description: summary.description ?? relative(cwd, entry),
		});
	}

	for (const entry of listDir(join(root, "extensions"))) {
		const path = isExtensionFile(entry) ? entry : findExtensionEntry(entry);
		if (!path) continue;
		items.push({
			kind: "extensions",
			path,
			label: basename(entry).replace(/\.(ts|js|mjs|cjs)$/, ""),
			description: relative(cwd, path),
		});
	}

	items.push(...discoverMcps(cwd));

	return items.sort((a, b) => `${a.kind}:${a.label}`.localeCompare(`${b.kind}:${b.label}`));
}

function selectedSet(selection: CwdSelection): Set<string> {
	return new Set([...selection.skills, ...selection.prompts, ...selection.extensions, ...selection.mcps]);
}

function summarize(cwd: string, selection: CwdSelection): string {
	const lines: string[] = [];
	for (const kind of ["skills", "prompts", "extensions", "mcps"] as const) {
		const values = selection[kind];
		if (values.length === 0) continue;
		lines.push(`${kind}:`);
		for (const value of values) lines.push(`  - ${kind === "mcps" ? value : relative(cwd, value)}`);
	}
	return lines.length === 0 ? "No ephemeral resources selected." : lines.join("\n");
}

type EphemeralPickerResult =
	| { action: "toggle"; item: ResourceItem }
	| { action: "show" }
	| { action: "clear" }
	| undefined;

const EPHEMERAL_PAGES = ["skills", "mcps"] as const;
const MAX_VISIBLE_PAGE_ITEMS = 12;

async function pickSkillOrMcpPage(
	ctx: ExtensionCommandContext,
	selection: CwdSelection,
	resources: ResourceItem[],
): Promise<EphemeralPickerResult> {
	const selected = selectedSet(selection);
	const byKind: Record<(typeof EPHEMERAL_PAGES)[number], ResourceItem[]> = {
		skills: resources.filter((item) => item.kind === "skills"),
		mcps: resources.filter((item) => item.kind === "mcps"),
	};

	return ctx.ui.custom<EphemeralPickerResult>((tui, theme, _keybindings, done) => {
		let pageIndex = 0;
		const rowByKind: Record<(typeof EPHEMERAL_PAGES)[number], number> = { skills: 0, mcps: 0 };
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;

		function activeKind(): (typeof EPHEMERAL_PAGES)[number] {
			return EPHEMERAL_PAGES[pageIndex];
		}

		function activeItems(): ResourceItem[] {
			return byKind[activeKind()];
		}

		function rowCount(kind = activeKind()): number {
			return byKind[kind].length + 2; // show selected + clear selected
		}

		function clampRow(kind = activeKind()): void {
			rowByKind[kind] = Math.max(0, Math.min(rowByKind[kind], rowCount(kind) - 1));
		}

		function refresh(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
			tui.requestRender();
		}

		function switchPage(delta: number): void {
			pageIndex = (pageIndex + delta + EPHEMERAL_PAGES.length) % EPHEMERAL_PAGES.length;
			clampRow();
			refresh();
		}

		function handleInput(data: string): void {
			const kind = activeKind();
			if (matchesKey(data, Key.left)) {
				switchPage(-1);
				return;
			}
			if (matchesKey(data, Key.right)) {
				switchPage(1);
				return;
			}
			if (matchesKey(data, Key.up)) {
				rowByKind[kind] = Math.max(0, rowByKind[kind] - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				rowByKind[kind] = Math.min(rowCount(kind) - 1, rowByKind[kind] + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const items = activeItems();
				const row = rowByKind[kind];
				if (row < items.length) {
					done({ action: "toggle", item: items[row] });
					return;
				}
				done({ action: row === items.length ? "show" : "clear" });
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
				done(undefined);
			}
		}

		function render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			const renderWidth = Math.max(1, width);
			const lines: string[] = [];
			const add = (line = "") => lines.push(truncateToWidth(line, renderWidth));
			const kind = activeKind();
			const items = activeItems();
			const row = rowByKind[kind];

			add(theme.fg("accent", "─".repeat(renderWidth)));
			add(` ${theme.fg("toolTitle", theme.bold("Ephemeral resources"))} ${theme.fg("dim", "(←/→ switch pages)")}`);

			const tabs = EPHEMERAL_PAGES.map((pageKind, index) => {
				const count = byKind[pageKind].filter((item) => selected.has(item.path)).length;
				const label = `${pageKind === "skills" ? "Skills" : "MCPs"} ${count}/${byKind[pageKind].length}`;
				return index === pageIndex ? theme.bg("selectedBg", ` ${label} `) : theme.fg("muted", ` ${label} `);
			});
			add(` ${tabs.join("  ")}`);
			add(theme.fg("dim", " ↑↓ navigate • Enter toggle/action • Esc cancel"));
			add("");

			if (items.length === 0) {
				add(` ${theme.fg("warning", kind === "skills" ? "No skills found." : "No MCP servers found.")}`);
			} else {
				const selectedItemIndex = Math.min(row, Math.max(0, items.length - 1));
				const maxStart = Math.max(0, items.length - MAX_VISIBLE_PAGE_ITEMS);
				const start = items.length <= MAX_VISIBLE_PAGE_ITEMS
					? 0
					: row >= items.length
						? maxStart
						: Math.min(Math.max(0, selectedItemIndex - Math.floor(MAX_VISIBLE_PAGE_ITEMS / 2)), maxStart);
				const visibleItems = items.slice(start, start + MAX_VISIBLE_PAGE_ITEMS);

				if (start > 0) add(` ${theme.fg("dim", `… ${start} earlier`)}`);
				for (let i = 0; i < visibleItems.length; i++) {
					const item = visibleItems[i];
					const absoluteIndex = start + i;
					const isCurrent = row === absoluteIndex;
					const cursor = isCurrent ? theme.fg("accent", ">") : " ";
					const mark = selected.has(item.path) ? theme.fg("success", "✓") : theme.fg("dim", "○");
					const label = `${cursor} ${mark} ${item.label}`;
					const descPrefix = "    ";
					const descWidth = Math.max(10, renderWidth - visibleWidth(descPrefix));
					add(`${label} ${theme.fg(isCurrent ? "accent" : "muted", "—")} ${theme.fg(isCurrent ? "text" : "muted", item.description)}`);
					if (visibleWidth(item.description) > descWidth) {
						add(`${descPrefix}${theme.fg("dim", truncateToWidth(item.description, descWidth))}`);
					}
				}
				const hiddenAfter = items.length - (start + visibleItems.length);
				if (hiddenAfter > 0) add(` ${theme.fg("dim", `… ${hiddenAfter} more`)}`);
			}

			add("");
			add(theme.fg("dim", "──────────"));
			const showSelectedRow = items.length;
			const clearSelectedRow = items.length + 1;
			add(`${row === showSelectedRow ? theme.fg("accent", ">") : " "} ${theme.fg(row === showSelectedRow ? "accent" : "text", "show selected")}`);
			add(`${row === clearSelectedRow ? theme.fg("accent", ">") : " "} ${theme.fg(row === clearSelectedRow ? "accent" : "text", "clear selected")}`);
			add(theme.fg("accent", "─".repeat(renderWidth)));

			cachedWidth = width;
			cachedLines = lines;
			return lines;
		}

		return {
			handleInput,
			render,
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
		};
	});
}

async function loadExtensionFactory(path: string): Promise<((pi: ExtensionAPI) => unknown) | undefined> {
	const packageDir = getPackageDir();
	const requireFromPi = createRequire(join(packageDir, "package.json"));
	const { createJiti } = await import(pathToFileURL(join(packageDir, "node_modules", "jiti", "lib", "jiti-static.mjs")).href);
	const piAiCompat = requireFromPi.resolve("@earendil-works/pi-ai/compat");
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		alias: {
			"@earendil-works/pi-coding-agent": join(packageDir, "dist", "index.js"),
			"@earendil-works/pi-tui": requireFromPi.resolve("@earendil-works/pi-tui"),
			"@earendil-works/pi-agent-core": requireFromPi.resolve("@earendil-works/pi-agent-core"),
			"@earendil-works/pi-ai": piAiCompat,
			"@earendil-works/pi-ai/compat": piAiCompat,
			"@earendil-works/pi-ai/oauth": requireFromPi.resolve("@earendil-works/pi-ai/oauth"),
			typebox: requireFromPi.resolve("typebox"),
			"typebox/compile": requireFromPi.resolve("typebox/compile"),
			"typebox/value": requireFromPi.resolve("typebox/value"),
		},
	});
	const factory = await jiti.import(path, { default: true });
	return typeof factory === "function" ? (factory as (pi: ExtensionAPI) => unknown) : undefined;
}

async function loadSelectedExtensions(
	pi: ExtensionAPI,
	cwd: string,
	loaded: Set<string>,
	onError?: (extensionPath: string, error: unknown) => void,
): Promise<void> {
	const selection = getSelection(cwd);
	for (const extensionPath of selection.extensions) {
		if (loaded.has(extensionPath)) continue;
		try {
			const factory = await loadExtensionFactory(extensionPath);
			if (!factory) throw new Error("extension does not export a default factory function");
			await factory(pi);
			loaded.add(extensionPath);
		} catch (error) {
			onError?.(extensionPath, error);
		}
	}
}

export default async function ephemeral(pi: ExtensionAPI) {
	const loadedExtensions = new Set<string>();
	await loadSelectedExtensions(pi, process.cwd(), loadedExtensions, (extensionPath, error) => {
		console.error(`Failed to load ephemeral extension ${extensionPath}: ${error instanceof Error ? error.message : String(error)}`);
	});

	pi.on("session_start", async (_event, ctx) => {
		await loadSelectedExtensions(pi, ctx.cwd, loadedExtensions, (extensionPath, error) => {
			ctx.ui.notify(`Failed to load ephemeral extension ${extensionPath}: ${error instanceof Error ? error.message : String(error)}`, "error");
		});
	});

	pi.on("resources_discover", (event) => {
		const selection = getSelection(event.cwd);
		return {
			skillPaths: selection.skills,
			promptPaths: selection.prompts,
		};
	});

	const ephemeralCommand = {
		description: `Enable global skills and session-local MCP servers`,
		getArgumentCompletions: (prefix: string) => {
			return ["list", "clear", "skill", "skills", "mcp", "mcps", "prompts", "extensions"]
				.filter((value) => value.startsWith(prefix.toLowerCase()))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			const needsTrustedProject = ["prompt", "prompts", "extension", "extensions"].includes(command);
			if (needsTrustedProject && !ctx.isProjectTrusted()) {
				ctx.ui.notify(`Project is not trusted. Run /trust before loading project-local ephemeral prompts/extensions.`, "warning");
				return;
			}

			let selection = getSelection(ctx.cwd);

			if (command === "list") {
				ctx.ui.notify(summarize(ctx.cwd, selection), "info");
				return;
			}

			if (command === "clear") {
				setSelection(ctx.cwd, EMPTY_SELECTION);
				ctx.ui.notify("Cleared ephemeral resources. Reloading...", "info");
				await ctx.reload();
				return;
			}

			const kindFilter = command === "skill" || command === "skills"
				? "skills"
				: command === "prompt" || command === "prompts"
					? "prompts"
					: command === "extension" || command === "extensions"
						? "extensions"
						: command === "mcp" || command === "mcps"
							? "mcps"
							: undefined;
			const defaultKinds = new Set<ResourceKind>(["skills", "mcps"]);
			const resources = discover(ctx.cwd).filter((item) => kindFilter ? item.kind === kindFilter : defaultKinds.has(item.kind));
			if (resources.length === 0) {
				const message = kindFilter === "mcps"
					? "No MCP servers found in configured MCP files."
					: kindFilter === "skills"
						? `No ephemeral skills found. Add skills under ${CONFIG_DIR_NAME}/ephemeral/skills.`
						: `No ephemeral skills or MCP servers found.`;
				ctx.ui.notify(message, "warning");
				return;
			}

			if (!kindFilter && ctx.mode === "tui") {
				const result = await pickSkillOrMcpPage(ctx, selection, resources);
				if (!result) return;

				if (result.action === "show") {
					ctx.ui.notify(summarize(ctx.cwd, selection), "info");
					return;
				}

				if (result.action === "clear") {
					setSelection(ctx.cwd, EMPTY_SELECTION);
					ctx.ui.notify("Cleared ephemeral resources. Reloading...", "info");
					await ctx.reload();
					return;
				}

				const selected = selectedSet(selection);
				const item = result.item;
				selection = {
					...selection,
					[item.kind]: toggle(selection[item.kind], item.path),
				};
				setSelection(ctx.cwd, selection);
				ctx.ui.notify(`${selected.has(item.path) ? "Disabled" : "Enabled"} ephemeral ${item.kind.slice(0, -1)}: ${item.label}. Reloading...`, "info");
				await ctx.reload();
				return;
			}

			const selected = selectedSet(selection);
			const choices = [
				...resources.map((item) => {
					const mark = selected.has(item.path) ? "✓" : "○";
					return `${mark} ${item.kind.slice(0, -1)}: ${item.label} — ${item.description}`;
				}),
				"──────────",
				"show selected",
				"clear selected",
			];

			const choice = await ctx.ui.select("Toggle ephemeral skill or MCP", choices);
			if (!choice || choice === "──────────") return;

			if (choice === "show selected") {
				ctx.ui.notify(summarize(ctx.cwd, selection), "info");
				return;
			}

			if (choice === "clear selected") {
				setSelection(ctx.cwd, EMPTY_SELECTION);
				ctx.ui.notify("Cleared ephemeral resources. Reloading...", "info");
				await ctx.reload();
				return;
			}

			const index = choices.indexOf(choice);
			const item = resources[index];
			if (!item) return;

			selection = {
				...selection,
				[item.kind]: toggle(selection[item.kind], item.path),
			};
			setSelection(ctx.cwd, selection);
			ctx.ui.notify(`${selected.has(item.path) ? "Disabled" : "Enabled"} ephemeral ${item.kind.slice(0, -1)}: ${item.label}. Reloading...`, "info");
			await ctx.reload();
		},
	};

	pi.registerCommand("ephemeral", ephemeralCommand);
}
