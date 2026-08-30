import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { basename } from "node:path";

const MAX_INDEX_ENTRIES = 50_000;
const MAX_SUGGESTIONS = 20;
const REFRESH_MS = 15_000;
const FAILURE_RETRY_MS = 3_000;
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

type IndexEntry = { path: string; isDirectory: boolean };
type FdResult = { stdout: string; code: number };
type FdRunner = (command: string, args: string[], signal: AbortSignal) => Promise<FdResult>;

type ParsedAtToken = {
	prefix: string;
	rawQuery: string;
	quoted: boolean;
};

function isTokenStart(text: string, index: number): boolean {
	return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

/** Extract the same unquoted and double-quoted @ token forms supported by pi. */
export function extractAtToken(textBeforeCursor: string): ParsedAtToken | undefined {
	let quoteStart = -1;
	let inQuotes = false;
	for (let index = 0; index < textBeforeCursor.length; index += 1) {
		if (textBeforeCursor[index] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) quoteStart = index;
		}
	}

	if (inQuotes && quoteStart > 0 && textBeforeCursor[quoteStart - 1] === "@") {
		const atIndex = quoteStart - 1;
		if (isTokenStart(textBeforeCursor, atIndex)) {
			return {
				prefix: textBeforeCursor.slice(atIndex),
				rawQuery: textBeforeCursor.slice(quoteStart + 1),
				quoted: true,
			};
		}
	}

	let delimiter = -1;
	for (let index = textBeforeCursor.length - 1; index >= 0; index -= 1) {
		if (PATH_DELIMITERS.has(textBeforeCursor[index] ?? "")) {
			delimiter = index;
			break;
		}
	}
	const tokenStart = delimiter + 1;
	if (textBeforeCursor[tokenStart] !== "@") return undefined;
	return {
		prefix: textBeforeCursor.slice(tokenStart),
		rawQuery: textBeforeCursor.slice(tokenStart + 1),
		quoted: false,
	};
}

/** Standard Levenshtein distance, stopped as soon as a second edit is required. */
export function isWithinOneEdit(left: string, right: string): boolean {
	if (Math.abs(left.length - right.length) > 1) return false;
	if (left === right) return true;

	let leftIndex = 0;
	let rightIndex = 0;
	let edits = 0;
	while (leftIndex < left.length && rightIndex < right.length) {
		if (left[leftIndex] === right[rightIndex]) {
			leftIndex += 1;
			rightIndex += 1;
			continue;
		}
		edits += 1;
		if (edits > 1) return false;
		if (left.length > right.length) leftIndex += 1;
		else if (right.length > left.length) rightIndex += 1;
		else {
			leftIndex += 1;
			rightIndex += 1;
		}
	}
	if (leftIndex < left.length || rightIndex < right.length) edits += 1;
	return edits <= 1;
}

function isOneEditFromPrefix(candidate: string, query: string): boolean {
	if (!query) return false;
	for (const length of [query.length - 1, query.length, query.length + 1]) {
		if (length < 0 || length > candidate.length) continue;
		const prefix = candidate.slice(0, length);
		if (prefix !== query && isWithinOneEdit(prefix, query)) return true;
	}
	return false;
}

function normalizeIndexedPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function isGitMetadata(path: string): boolean {
	return path === ".git" || path.startsWith(".git/") || path.includes("/.git/");
}

export class FdFileIndex {
	private entries: IndexEntry[] = [];
	private loadedAt = 0;
	private failedAt = 0;
	private loading: Promise<IndexEntry[]> | undefined;
	private readonly lifetime = new AbortController();
	private readonly run: FdRunner;

	constructor(run: FdRunner) {
		this.run = run;
	}

	dispose(): void {
		this.lifetime.abort();
	}

	async get(signal: AbortSignal): Promise<IndexEntry[] | undefined> {
		if (signal.aborted) return undefined;
		const now = Date.now();
		if (this.entries.length > 0 && now - this.loadedAt < REFRESH_MS) return this.entries;
		if (this.failedAt > 0 && now - this.failedAt < FAILURE_RETRY_MS) {
			return this.entries.length > 0 ? this.entries : undefined;
		}
		this.loading ??= this.refresh().finally(() => {
			this.loading = undefined;
		});
		return raceWithAbort(this.loading, signal);
	}

	private async refresh(): Promise<IndexEntry[]> {
		const args = [
			"--base-directory", ".",
			"--max-results", String(MAX_INDEX_ENTRIES),
			"--type", "f",
			"--type", "d",
			"--follow",
			"--hidden",
			"--exclude", ".git",
			"--exclude", ".git/*",
			"--exclude", ".git/**",
			"--print0",
		];

		let result = await this.run("fd", args, this.lifetime.signal);
		if (result.code !== 0 && !this.lifetime.signal.aborted) {
			result = await this.run("fdfind", args, this.lifetime.signal);
		}
		if (result.code !== 0 || this.lifetime.signal.aborted) {
			this.failedAt = Date.now();
			return this.entries;
		}

		const entries: IndexEntry[] = [];
		for (const rawPath of result.stdout.split("\0")) {
			if (!rawPath) continue;
			const slashPath = rawPath.replace(/\\/g, "/");
			const isDirectory = slashPath.endsWith("/");
			const path = normalizeIndexedPath(slashPath);
			if (!path || isGitMetadata(path)) continue;
			entries.push({ path, isDirectory });
		}
		entries.sort((left, right) => compareText(left.path, right.path));
		this.entries = entries;
		this.loadedAt = Date.now();
		this.failedAt = 0;
		return entries;
	}
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	if (signal.aborted) return undefined;
	return new Promise<T | undefined>((resolve, reject) => {
		const abort = () => resolve(undefined);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function buildValue(path: string, isDirectory: boolean, quoted: boolean): string {
	const completionPath = `${path}${isDirectory ? "/" : ""}`;
	return quoted || completionPath.includes(" ") ? `@"${completionPath}"` : `@${completionPath}`;
}

export function rankFileEntries(
	entries: readonly IndexEntry[],
	token: ParsedAtToken,
	limit = MAX_SUGGESTIONS,
): AutocompleteItem[] {
	const normalizedQuery = token.rawQuery.replace(/\\/g, "/");
	if (normalizedQuery.startsWith("/") || normalizedQuery.startsWith("~/") || normalizedQuery.startsWith("../")) {
		return [];
	}

	const slashIndex = normalizedQuery.lastIndexOf("/");
	const displayBase = slashIndex >= 0 ? normalizedQuery.slice(0, slashIndex + 1) : "";
	const scope = displayBase.replace(/^\.\//, "").toLowerCase();
	const query = (slashIndex >= 0 ? normalizedQuery.slice(slashIndex + 1) : normalizedQuery).toLowerCase();
	const ranked: Array<{ entry: IndexEntry; category: number }> = [];

	for (const entry of entries) {
		const lowerPath = entry.path.toLowerCase();
		if (scope && !lowerPath.startsWith(scope)) continue;
		const relativeToScope = scope ? entry.path.slice(scope.length) : entry.path;
		const name = basename(entry.path).toLowerCase();
		let category = -1;
		if (query && (name === query || relativeToScope.toLowerCase() === query)) category = 0;
		else if (!query || name.startsWith(query)) category = 1;
		else if (name.includes(query)) category = 2;
		else if (relativeToScope.toLowerCase().includes(query)) category = 3;
		else if (isOneEditFromPrefix(name, query)) category = 4;
		if (category >= 0) ranked.push({ entry, category });
	}

	ranked.sort((left, right) =>
		left.category - right.category
		|| Number(right.entry.isDirectory) - Number(left.entry.isDirectory)
		|| left.entry.path.length - right.entry.path.length
		|| compareText(left.entry.path, right.entry.path));

	return ranked.slice(0, limit).map(({ entry }) => {
		const outputPath = displayBase
			? `${displayBase}${entry.path.slice(scope.length)}`
			: entry.path;
		return {
			value: buildValue(outputPath, entry.isDirectory, token.quoted),
			label: `${basename(entry.path)}${entry.isDirectory ? "/" : ""}`,
			description: outputPath,
		};
	});
}

export function createFuzzyFileProvider(
	current: AutocompleteProvider,
	index: FdFileIndex,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const token = extractAtToken(textBeforeCursor);
			if (!token) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const existing = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (options.signal.aborted || (existing && existing.prefix !== token.prefix)) return existing;
			if ((existing?.items.length ?? 0) >= MAX_SUGGESTIONS) return existing;

			const entries = await index.get(options.signal);
			if (!entries || options.signal.aborted) return existing;
			const additions = rankFileEntries(entries, token, MAX_SUGGESTIONS);
			const seen = new Set(existing?.items.map((item) => item.value) ?? []);
			const items = [...(existing?.items ?? [])];
			for (const item of additions) {
				if (!seen.has(item.value)) {
					seen.add(item.value);
					items.push(item);
				}
				if (items.length >= MAX_SUGGESTIONS) break;
			}
			return items.length > 0 ? { prefix: token.prefix, items } : existing;
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function fuzzyFileAutocomplete(pi: ExtensionAPI): void {
	let index: FdFileIndex | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		index = new FdFileIndex((command, args, signal) =>
			pi.exec(command, args, { cwd: ctx.cwd, signal, timeout: 10_000 }));
		ctx.ui.addAutocompleteProvider((current) => createFuzzyFileProvider(current, index!));
	});
	pi.on("session_shutdown", () => {
		index?.dispose();
		index = undefined;
	});
}
