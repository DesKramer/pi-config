import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";

const RERENDER_KEY = "tps-status";
const MIN_UPDATE_INTERVAL_MS = 250;
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

type TpsState = {
	startedAt: number;
	lastUpdatedAt: number;
	generatedChars: number;
	lastDisplay: string;
};

function estimateTokens(chars: number): number {
	return Math.max(0, Math.round(chars / 4));
}

function formatTps(tokens: number, elapsedMs: number, approximate: boolean): string {
	const elapsedSeconds = Math.max(elapsedMs / 1000, 0.001);
	const tps = tokens / elapsedSeconds;
	const value = tps < 10 ? tps.toFixed(1) : tps.toFixed(0);
	return `${approximate ? "~" : ""}${value}`;
}

function outputTokens(message: unknown): number | undefined {
	const usage = (message as { usage?: { output?: unknown } })?.usage;
	return typeof usage?.output === "number" && Number.isFinite(usage.output) ? usage.output : undefined;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function visibleWidth(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}

function truncateToWidth(text: string, width: number, ellipsis = "..."): string {
	if (visibleWidth(text) <= width) return text;
	const plain = text.replace(ANSI_PATTERN, "");
	if (width <= ellipsis.length) return ellipsis.slice(0, width);
	return plain.slice(0, width - ellipsis.length) + ellipsis;
}

function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function createFooter(getCtx: () => any, pi: ExtensionAPI, getTpsDisplay: () => string) {
	return (_tui: any, theme: any, footerData: any) => ({
		render(width: number): string[] {
			const ctx = getCtx();
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheWrite = 0;
			let totalCost = 0;
			let latestCacheHitRate: number | undefined;

			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					totalInput += entry.message.usage.input;
					totalOutput += entry.message.usage.output;
					totalCacheRead += entry.message.usage.cacheRead;
					totalCacheWrite += entry.message.usage.cacheWrite;
					totalCost += entry.message.usage.cost.total;

					const latestPromptTokens =
						entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
					latestCacheHitRate = latestPromptTokens > 0
						? (entry.message.usage.cacheRead / latestPromptTokens) * 100
						: undefined;
				}
			}

			const contextUsage = ctx.getContextUsage();
			const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const contextPercentValue = contextUsage?.percent ?? 0;
			const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined
				? contextPercentValue.toFixed(1)
				: "?";

			let pwd = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
			const branch = footerData.getGitBranch?.();
			if (branch) pwd = `${pwd} (${branch})`;
			const sessionName = ctx.sessionManager.getSessionName();
			if (sessionName) pwd = `${pwd} • ${sessionName}`;

			const statsParts: string[] = [];
			if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
			if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
			if ((totalCacheRead > 0 || totalCacheWrite > 0) && latestCacheHitRate !== undefined) {
				statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
			}

			const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
			if (totalCost || usingSubscription) {
				statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
			}

			const contextPercentDisplay = contextPercent === "?"
				? `?/${formatTokens(contextWindow)}`
				: `${contextPercent}%/${formatTokens(contextWindow)}`;
			const contextPercentStr = contextPercentValue > 90
				? theme.fg("error", contextPercentDisplay)
				: contextPercentValue > 70
					? theme.fg("warning", contextPercentDisplay)
					: contextPercentDisplay;
			statsParts.push(contextPercentStr);
			statsParts.push(`${getTpsDisplay()} tok/s`);

			let statsLeft = statsParts.join(" ");
			let statsLeftWidth = visibleWidth(statsLeft);
			if (statsLeftWidth > width) {
				statsLeft = truncateToWidth(statsLeft, width, "...");
				statsLeftWidth = visibleWidth(statsLeft);
			}

			const modelName = ctx.model?.id || "no-model";
			let rightSideWithoutProvider = modelName;
			if (ctx.model?.reasoning) {
				const thinkingLevel = pi.getThinkingLevel?.() || "off";
				rightSideWithoutProvider = thinkingLevel === "off"
					? `${modelName} • thinking off`
					: `${modelName} • ${thinkingLevel}`;
			}

			let rightSide = rightSideWithoutProvider;
			const providerCount = new Set(ctx.modelRegistry.getAvailable().map((model: any) => model.provider)).size;
			if (providerCount > 1 && ctx.model) {
				const withProvider = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
				if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
			}

			const rightSideWidth = visibleWidth(rightSide);
			const minPadding = 2;
			let statsLine: string;
			if (statsLeftWidth + minPadding + rightSideWidth <= width) {
				statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
			} else {
				const availableForRight = width - statsLeftWidth - minPadding;
				if (availableForRight > 0) {
					const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
					statsLine = statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight))) + truncatedRight;
				} else {
					statsLine = statsLeft;
				}
			}

			const dimStatsLeft = theme.fg("dim", statsLeft);
			const dimRemainder = theme.fg("dim", statsLine.slice(statsLeft.length));
			const lines = [
				truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
				dimStatsLeft + dimRemainder,
			];

			const extensionStatuses = footerData.getExtensionStatuses?.();
			if (extensionStatuses?.size > 0) {
				const statusLine = Array.from(extensionStatuses.entries())
					.filter(([key]) => key !== RERENDER_KEY)
					.sort(([a], [b]) => String(a).localeCompare(String(b)))
					.map(([, text]) => sanitizeStatusText(String(text)))
					.join(" ");
				if (statusLine) lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
			}

			return lines;
		},
	});
}

export default function (pi: ExtensionAPI): void {
	let state: TpsState | undefined;
	let lastTpsDisplay = "--";
	let renderCtx: any;

	const requestFooterRender = (ctx: any) => {
		if (ctx.hasUI) ctx.ui.setStatus(RERENDER_KEY, undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		renderCtx = ctx;
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter(createFooter(() => renderCtx, pi, () => lastTpsDisplay));
		requestFooterRender(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		renderCtx = ctx;
		requestFooterRender(ctx);
	});

	pi.on("message_update", (event, ctx) => {
		renderCtx = ctx;
		if (!ctx.hasUI) return;

		const now = Date.now();
		if (event.assistantMessageEvent.type === "start" || !state) {
			state = { startedAt: now, lastUpdatedAt: 0, generatedChars: 0, lastDisplay: lastTpsDisplay };
		}

		const streamEvent = event.assistantMessageEvent;
		if (
			streamEvent.type === "text_delta" ||
			streamEvent.type === "thinking_delta" ||
			streamEvent.type === "toolcall_delta"
		) {
			state.generatedChars += streamEvent.delta.length;
		}

		if (now - state.lastUpdatedAt < MIN_UPDATE_INTERVAL_MS && streamEvent.type !== "done") return;

		const actualTokens = outputTokens(event.message);
		const approximate = actualTokens === undefined || actualTokens === 0;
		const tokens = approximate ? estimateTokens(state.generatedChars) : actualTokens;

		state.lastUpdatedAt = now;
		state.lastDisplay = formatTps(tokens, now - state.startedAt, approximate);
		lastTpsDisplay = state.lastDisplay;
		requestFooterRender(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		renderCtx = ctx;
		if (!ctx.hasUI || event.message.role !== "assistant" || !state) return;

		const now = Date.now();
		const actualTokens = outputTokens(event.message);
		const approximate = actualTokens === undefined || actualTokens === 0;
		const tokens = approximate ? estimateTokens(state.generatedChars) : actualTokens;

		state.lastDisplay = formatTps(tokens, now - state.startedAt, approximate);
		lastTpsDisplay = state.lastDisplay;
		requestFooterRender(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		renderCtx = ctx;
		if (!ctx.hasUI) return;
		lastTpsDisplay = state?.lastDisplay ?? lastTpsDisplay;
		state = undefined;
		requestFooterRender(ctx);
	});
}
