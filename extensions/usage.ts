import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { opendir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const ENTRY_TYPE = "pi-usage-report";
const DAY_MS = 24 * 60 * 60 * 1000;

type UsageTotals = {
	calls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costUsd: number;
};

type WindowReport = {
	label: string;
	sinceMs: number;
	totals: UsageTotals;
};

type SubagentWindowReport = {
	label: string;
	sinceMs: number;
	byAgent: Record<string, UsageTotals>;
};

type SubagentReportData = {
	currentSession: Record<string, UsageTotals>;
	windows: SubagentWindowReport[];
	uniqueRuns: number;
	duplicateRuns: number;
	missingUsageRuns: number;
	filesWithSubagents: number;
};

type UsageReportData = {
	generatedAt: number;
	sessionDir: string;
	currentSessionFile?: string;
	filesScanned: number;
	filesWithUsage: number;
	uniqueAssistantMessages: number;
	duplicateAssistantMessages: number;
	currentSession: UsageTotals;
	windows: WindowReport[];
	totalSpendUsd?: number;
	subagents?: SubagentReportData;
	warnings: string[];
};

type AssistantUsageMessage = {
	role?: string;
	provider?: string;
	model?: string;
	api?: string;
	timestamp?: number;
	stopReason?: string;
	content?: unknown;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			total?: number;
		};
	};
};

type UsageRecord = {
	key: string;
	timestampMs: number;
	file?: string;
	usage: Required<NonNullable<AssistantUsageMessage["usage"]>> & {
		cost: Required<NonNullable<NonNullable<AssistantUsageMessage["usage"]>["cost"]>>;
	};
};

type SubagentUsageRecord = UsageRecord & {
	agent: string;
};

type FileRecords = {
	usage: UsageRecord[];
	subagents: SubagentUsageRecord[];
	subagentMissingUsage: number;
};

function emptyTotals(): UsageTotals {
	return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
}

function addUsage(totals: UsageTotals, record: UsageRecord): void {
	const usage = record.usage;
	totals.calls += 1;
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.totalTokens += usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	totals.costUsd += usage.cost.total;
}

function normalizeUsage(message: AssistantUsageMessage): UsageRecord["usage"] | undefined {
	const usage = message.usage;
	if (!usage) return undefined;

	const input = finiteNumber(usage.input);
	const output = finiteNumber(usage.output);
	const cacheRead = finiteNumber(usage.cacheRead);
	const cacheWrite = finiteNumber(usage.cacheWrite);
	const totalTokens = finiteNumber(usage.totalTokens) || input + output + cacheRead + cacheWrite;
	const cost = usage.cost ?? {};

	if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && totalTokens === 0 && finiteNumber(cost.total) === 0) {
		return undefined;
	}

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: {
			input: finiteNumber(cost.input),
			output: finiteNumber(cost.output),
			cacheRead: finiteNumber(cost.cacheRead),
			cacheWrite: finiteNumber(cost.cacheWrite),
			total: finiteNumber(cost.total),
		},
	};
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function messageTimestampMs(entry: { timestamp?: unknown }, message: { timestamp?: unknown }): number | undefined {
	if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
	if (typeof entry.timestamp === "string") {
		const parsed = Date.parse(entry.timestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function assistantKey(message: AssistantUsageMessage, usage: UsageRecord["usage"], timestampMs: number): string {
	// Forks/clones can copy historical assistant messages into new session files. Those copies are not new spend.
	// Use a content+usage fingerprint so cross-file copied history is counted once while separate real calls remain counted.
	const payload = JSON.stringify({
		timestampMs,
		provider: message.provider,
		model: message.model,
		api: message.api,
		stopReason: message.stopReason,
		usage,
		content: message.content,
	});
	return createHash("sha256").update(payload).digest("hex");
}

function recordFromEntry(entry: any, file?: string): UsageRecord | undefined {
	if (!entry || entry.type !== "message") return undefined;
	const message = entry.message as AssistantUsageMessage | undefined;
	if (!message || message.role !== "assistant") return undefined;
	const usage = normalizeUsage(message);
	if (!usage) return undefined;
	const timestampMs = messageTimestampMs(entry, message);
	if (timestampMs === undefined) return undefined;
	return { key: assistantKey(message, usage, timestampMs), timestampMs, file, usage };
}

function getAgentTotals(byAgent: Record<string, UsageTotals>, agent: string): UsageTotals {
	return byAgent[agent] ??= emptyTotals();
}

function addSubagentUsage(byAgent: Record<string, UsageTotals>, record: SubagentUsageRecord): void {
	addUsage(getAgentTotals(byAgent, record.agent), record);
}

function normalizeSubagentUsage(value: unknown): UsageRecord["usage"] | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const input = finiteNumber(raw.input);
	const output = finiteNumber(raw.output);
	const cacheRead = finiteNumber(raw.cacheRead);
	const cacheWrite = finiteNumber(raw.cacheWrite);
	const totalTokens = input + output + cacheRead + cacheWrite;
	const costTotal = finiteNumber(raw.cost);
	if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && totalTokens === 0 && costTotal === 0) {
		return undefined;
	}
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
	};
}

function subagentKey(
	message: { toolCallId?: unknown },
	result: Record<string, unknown>,
	usage: UsageRecord["usage"],
	timestampMs: number,
	path: string,
): string {
	const payload = JSON.stringify({
		timestampMs,
		toolCallId: message.toolCallId,
		path,
		agent: result.agent,
		model: result.model,
		task: result.task,
		usage,
	});
	return createHash("sha256").update(payload).digest("hex");
}

function collectSubagentResultRecords(
	result: unknown,
	message: { toolCallId?: unknown },
	timestampMs: number,
	path: string,
	file: string | undefined,
	records: SubagentUsageRecord[],
): number {
	if (!result || typeof result !== "object") return 0;
	const obj = result as Record<string, any>;
	let missingUsage = 0;
	const agent = typeof obj.agent === "string" && obj.agent.trim() ? obj.agent.trim() : "unknown";
	const usage = normalizeSubagentUsage(obj.usage);
	if (usage) {
		records.push({
			key: subagentKey(message, obj, usage, timestampMs, path),
			timestampMs,
			file,
			agent,
			usage,
		});
	} else {
		missingUsage += 1;
	}

	const recentTools = obj.progress?.recentTools;
	if (Array.isArray(recentTools)) {
		for (let i = 0; i < recentTools.length; i++) {
			const children = recentTools[i]?.children;
			if (!Array.isArray(children)) continue;
			for (let j = 0; j < children.length; j++) {
				missingUsage += collectSubagentResultRecords(children[j], message, timestampMs, `${path}.tool${i}.child${j}`, file, records);
			}
		}
	}
	return missingUsage;
}

function subagentRecordsFromEntry(entry: any, file?: string): { records: SubagentUsageRecord[]; missingUsage: number } {
	if (!entry || entry.type !== "message") return { records: [], missingUsage: 0 };
	const message = entry.message as { role?: string; toolName?: string; toolCallId?: unknown; timestamp?: unknown; details?: unknown } | undefined;
	if (!message || message.role !== "toolResult" || message.toolName !== "subagent") return { records: [], missingUsage: 0 };
	const timestampMs = messageTimestampMs(entry, message);
	if (timestampMs === undefined) return { records: [], missingUsage: 0 };
	const details = message.details as { results?: unknown } | undefined;
	const results = Array.isArray(details?.results) ? details.results : [];
	const records: SubagentUsageRecord[] = [];
	let missingUsage = 0;
	for (let i = 0; i < results.length; i++) {
		missingUsage += collectSubagentResultRecords(results[i], message, timestampMs, `result${i}`, file, records);
	}
	return { records, missingUsage };
}

async function* findJsonlFiles(root: string): AsyncGenerator<string> {
	let dir;
	try {
		dir = await opendir(root);
	} catch {
		return;
	}

	for await (const entry of dir) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			yield* findJsonlFiles(path);
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			yield path;
		}
	}
}

async function readRecordsFromFile(file: string, warnings: string[]): Promise<FileRecords> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		warnings.push(`Could not read ${file}: ${errorMessage(error)}`);
		return { usage: [], subagents: [], subagentMissingUsage: 0 };
	}

	const records: FileRecords = { usage: [], subagents: [], subagentMissingUsage: 0 };
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim();
		if (!line) continue;
		try {
			const entry = JSON.parse(line);
			const record = recordFromEntry(entry, file);
			if (record) records.usage.push(record);
			const subagents = subagentRecordsFromEntry(entry, file);
			records.subagents.push(...subagents.records);
			records.subagentMissingUsage += subagents.missingUsage;
		} catch (error) {
			warnings.push(`Could not parse ${file}:${i + 1}: ${errorMessage(error)}`);
		}
	}
	return records;
}

function usageRecordsFromEntries(entries: unknown[], sessionFile?: string): UsageRecord[] {
	const records: UsageRecord[] = [];
	for (const entry of entries) {
		const record = recordFromEntry(entry, sessionFile);
		if (record) records.push(record);
	}
	return records;
}

function subagentRecordsFromEntries(entries: unknown[], sessionFile?: string): { records: SubagentUsageRecord[]; missingUsage: number } {
	const records: SubagentUsageRecord[] = [];
	let missingUsage = 0;
	for (const entry of entries) {
		const subagents = subagentRecordsFromEntry(entry, sessionFile);
		records.push(...subagents.records);
		missingUsage += subagents.missingUsage;
	}
	return { records, missingUsage };
}

function defaultSessionsRoot(): string {
	if (process.env.PI_CODING_AGENT_SESSION_DIR) return resolve(process.env.PI_CODING_AGENT_SESSION_DIR);
	const agentDir = process.env.PI_CODING_AGENT_DIR
		? resolve(process.env.PI_CODING_AGENT_DIR)
		: join(homedir(), ".pi", "agent");
	return join(agentDir, "sessions");
}

function formatTokens(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1_000) return Math.round(value).toString();
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

function formatUsd(value: number): string {
	if (!Number.isFinite(value) || value === 0) return "$0.0000";
	if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
	if (Math.abs(value) < 100) return `$${value.toFixed(2)}`;
	return `$${value.toFixed(0)}`;
}

function formatTotalUsd(value: number): string {
	if (!Number.isFinite(value) || value === 0) return "$0.00";
	if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

function padLeft(value: string, width: number): string {
	return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function padRight(value: string, width: number): string {
	return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function tableLine(label: string, totals: UsageTotals): string {
	return [
		padRight(label, 12),
		padLeft(totals.calls.toString(), 6),
		padLeft(formatTokens(totals.input), 8),
		padLeft(formatTokens(totals.output), 8),
		padLeft(formatTokens(totals.cacheRead), 8),
		padLeft(formatTokens(totals.cacheWrite), 8),
		padLeft(formatTokens(totals.totalTokens), 8),
		padLeft(formatUsd(totals.costUsd), 10),
	].join("  ");
}

function subagentTableLine(agent: string, label: string, totals: UsageTotals): string {
	return [
		padRight(agent, 12),
		padRight(label, 10),
		padLeft(totals.calls.toString(), 5),
		padLeft(formatTokens(totals.input), 8),
		padLeft(formatTokens(totals.output), 8),
		padLeft(formatTokens(totals.cacheRead), 8),
		padLeft(formatTokens(totals.cacheWrite), 8),
		padLeft(formatTokens(totals.totalTokens), 8),
		padLeft(formatUsd(totals.costUsd), 10),
	].join("  ");
}

function subagentAgents(subagents: SubagentReportData | undefined): string[] {
	if (!subagents) return [];
	const agents = new Set<string>();
	for (const [agent, totals] of Object.entries(subagents.currentSession)) {
		if (totals.calls > 0) agents.add(agent);
	}
	for (const window of subagents.windows) {
		for (const [agent, totals] of Object.entries(window.byAgent)) {
			if (totals.calls > 0) agents.add(agent);
		}
	}
	return [...agents].sort();
}

function formatSubagentReport(subagents: SubagentReportData | undefined): string[] {
	const agents = subagentAgents(subagents);
	const lines = ["", "Subagent spend"];
	if (!subagents || agents.length === 0) {
		lines.push("No recorded subagent usage found yet. Future subagent runs with usage details will appear here.");
		return lines;
	}

	lines.push("Current = this session; time windows = all saved Pi sessions. Runs may include nested child subagents.");
	lines.push("");
	lines.push([
		padRight("Agent", 12),
		padRight("Window", 10),
		padLeft("Runs", 5),
		padLeft("Input", 8),
		padLeft("Output", 8),
		padLeft("Cache R", 8),
		padLeft("Cache W", 8),
		padLeft("Tokens", 8),
		padLeft("USD", 10),
	].join("  "));
	for (const agent of agents) {
		lines.push(subagentTableLine(agent, "Current", subagents.currentSession[agent] ?? emptyTotals()));
		for (const window of subagents.windows) {
			lines.push(subagentTableLine(agent, window.label, window.byAgent[agent] ?? emptyTotals()));
		}
	}
	lines.push(`Recorded ${subagents.uniqueRuns} unique subagent run(s) from ${subagents.filesWithSubagents} session file(s).`);
	if (subagents.duplicateRuns > 0) lines.push(`Deduped ${subagents.duplicateRuns} copied subagent run(s) from forks/clones.`);
	if (subagents.missingUsageRuns > 0) lines.push(`${subagents.missingUsageRuns} historical subagent run(s) had no usage details to count.`);
	return lines;
}

function formatReport(data: UsageReportData): string {
	const lines = [
		"Pi usage",
		`Generated: ${new Date(data.generatedAt).toLocaleString()}`,
		"Current = this session; time windows = all saved Pi sessions under the session root.",
		"",
		[
			padRight("Window", 12),
			padLeft("Calls", 6),
			padLeft("Input", 8),
			padLeft("Output", 8),
			padLeft("Cache R", 8),
			padLeft("Cache W", 8),
			padLeft("Tokens", 8),
			padLeft("USD", 10),
		].join("  "),
		tableLine("Current", data.currentSession),
		...data.windows.map((window) => tableLine(window.label, window.totals)),
		...formatSubagentReport(data.subagents),
		"",
		`Scanned ${data.filesScanned} session file(s), ${data.filesWithUsage} with usage; ${data.uniqueAssistantMessages} unique assistant call(s).`,
	];

	if (data.duplicateAssistantMessages > 0) {
		lines.push(`Deduped ${data.duplicateAssistantMessages} copied assistant message(s) from forks/clones.`);
	}
	if (data.warnings.length > 0) {
		lines.push(`Warnings: ${data.warnings.length} (expand for details)`);
	}
	const totalSpend = data.totalSpendUsd === undefined ? "Unavailable for this saved report" : formatTotalUsd(data.totalSpendUsd);
	lines.push("", `Total spend (Pi + subagents, all time): ${totalSpend}`);
	return lines.join("\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function buildWindows(now: number): WindowReport[] {
	return [
		{ label: "24 hours", sinceMs: now - DAY_MS, totals: emptyTotals() },
		{ label: "7 days", sinceMs: now - 7 * DAY_MS, totals: emptyTotals() },
		{ label: "30 days", sinceMs: now - 30 * DAY_MS, totals: emptyTotals() },
	];
}

function buildSubagentWindows(now: number): SubagentWindowReport[] {
	return [
		{ label: "24 hours", sinceMs: now - DAY_MS, byAgent: {} },
		{ label: "7 days", sinceMs: now - 7 * DAY_MS, byAgent: {} },
		{ label: "30 days", sinceMs: now - 30 * DAY_MS, byAgent: {} },
	];
}

async function collectUsage(ctx: any): Promise<UsageReportData> {
	const now = Date.now();
	const sessionDir = defaultSessionsRoot();
	const currentSessionFile = ctx.sessionManager?.getSessionFile?.() || undefined;
	const warnings: string[] = [];
	const byKey = new Map<string, UsageRecord>();
	const subagentsByKey = new Map<string, SubagentUsageRecord>();
	const currentSession = emptyTotals();
	const currentSubagents: Record<string, UsageTotals> = {};
	let filesScanned = 0;
	let filesWithUsage = 0;
	let filesWithSubagents = 0;
	let duplicateAssistantMessages = 0;
	let duplicateSubagentRuns = 0;
	let subagentMissingUsage = 0;

	for await (const file of findJsonlFiles(sessionDir)) {
		filesScanned += 1;
		const records = await readRecordsFromFile(file, warnings);
		if (records.usage.length > 0) filesWithUsage += 1;
		if (records.subagents.length > 0) filesWithSubagents += 1;
		subagentMissingUsage += records.subagentMissingUsage;
		for (const record of records.usage) {
			if (byKey.has(record.key)) duplicateAssistantMessages += 1;
			else byKey.set(record.key, record);
		}
		for (const record of records.subagents) {
			if (subagentsByKey.has(record.key)) duplicateSubagentRuns += 1;
			else subagentsByKey.set(record.key, record);
		}
	}

	// Include the live session manager too. For persisted sessions this is usually a duplicate of the file,
	// but it covers unsaved/in-memory sessions and any just-appended assistant/subagent usage.
	const liveEntries = ctx.sessionManager?.getEntries?.() ?? [];
	const liveRecords = usageRecordsFromEntries(liveEntries, currentSessionFile);
	for (const record of liveRecords) {
		addUsage(currentSession, record);
		if (!byKey.has(record.key)) byKey.set(record.key, record);
	}
	const liveSubagents = subagentRecordsFromEntries(liveEntries, currentSessionFile);
	subagentMissingUsage += liveSubagents.missingUsage;
	for (const record of liveSubagents.records) {
		addSubagentUsage(currentSubagents, record);
		if (!subagentsByKey.has(record.key)) subagentsByKey.set(record.key, record);
	}

	const windows = buildWindows(now);
	for (const record of byKey.values()) {
		for (const window of windows) {
			if (record.timestampMs >= window.sinceMs && record.timestampMs <= now) addUsage(window.totals, record);
		}
	}

	const subagentWindows = buildSubagentWindows(now);
	for (const record of subagentsByKey.values()) {
		for (const window of subagentWindows) {
			if (record.timestampMs >= window.sinceMs && record.timestampMs <= now) addSubagentUsage(window.byAgent, record);
		}
	}

	let totalSpendUsd = 0;
	for (const record of byKey.values()) totalSpendUsd += record.usage.cost.total;
	for (const record of subagentsByKey.values()) totalSpendUsd += record.usage.cost.total;

	return {
		generatedAt: now,
		sessionDir,
		currentSessionFile,
		filesScanned,
		filesWithUsage,
		uniqueAssistantMessages: byKey.size,
		duplicateAssistantMessages,
		currentSession,
		windows,
		totalSpendUsd,
		subagents: {
			currentSession: currentSubagents,
			windows: subagentWindows,
			uniqueRuns: subagentsByKey.size,
			duplicateRuns: duplicateSubagentRuns,
			missingUsageRuns: subagentMissingUsage,
			filesWithSubagents,
		},
		warnings,
	};
}

export default function usageCommand(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<UsageReportData>(ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", formatReport(data)), 0, 0));

		if (expanded) {
			const details = [
				"",
				`Session scan root: ${data.sessionDir}`,
				`Current session: ${data.currentSessionFile ?? "in-memory"}`,
				...data.warnings.map((warning) => `Warning: ${warning}`),
			].join("\n");
			box.addChild(new Text(theme.fg("dim", details), 0, 0));
		}

		return box;
	});

	pi.registerCommand("usage", {
		description: "Show Pi and subagent token usage/USD spend for this session and the last 24h/7d/30d",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			try {
				const report = await collectUsage(ctx);
				pi.appendEntry<UsageReportData>(ENTRY_TYPE, report);
				if (ctx.hasUI) ctx.ui.notify("Usage report added to the transcript.", "info");
			} catch (error) {
				ctx.ui.notify(`Failed to build usage report: ${errorMessage(error)}`, "error");
			}
		},
	});
}
