import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { AssistantMessage, Context, Model, Api, Usage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { estimateTokens, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	Archive, CONFIG_ENTRY, LIMITS, blockText, blocksOnBranch, checkpointOnBranch, configOnBranch,
	page, selectHistory, snapshotText, tokens, type Config, type Snapshot,
} from "./core.ts";
import { capture, checkpointDetails, reconcile, type MemoryWriter } from "./memory.ts";

// The checkout can have older type packages than the running harness. This is the
// documented 0.85 ModelRegistry interface; refuse unsupported runtimes explicitly.
interface CompletingRegistry {
	complete(model: Model<Api>, context: Context, options: {
		maxTokens: number; signal: AbortSignal; cacheRetention: "none"; sessionId: string;
	}): Promise<AssistantMessage>;
}
function completingRegistry(ctx: ExtensionContext): CompletingRegistry {
	const registry = ctx.modelRegistry as unknown as Partial<CompletingRegistry>;
	if (typeof registry.complete !== "function") throw new Error("l-mem requires Pi 0.85.1 or newer. Update the Pi harness first.");
	return registry as CompletingRegistry;
}

function addUsage(total: Usage, usage: Usage): void {
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += usage[key];
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost[key];
}
function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export default function memoryExtension(pi: ExtensionAPI) {
	let busy = false;
	let controller = new AbortController();
	let lastError: string | undefined;
	pi.registerFlag("l-mem", { type: "boolean", default: false, description: "Enable same-session functional memory. Archives original events and makes extra model calls." });
	pi.registerFlag("l-mem-model", { type: "string", description: "Memory writer provider/model. Defaults to the session model." });

	function config(ctx: ExtensionContext): Config {
		const selected = pi.getFlag("l-mem-model");
		return configOnBranch(ctx.sessionManager.getBranch(), {
			enabled: pi.getFlag("l-mem") === true,
			model: typeof selected === "string" && selected ? selected : undefined,
		});
	}
	function archive(ctx: ExtensionContext): Archive {
		const file = ctx.sessionManager.getSessionFile();
		if (!file) throw new Error("l-mem requires a saved session; --no-session is not supported");
		// Sibling sessions share immutable artifacts so /fork and /clone keep their
		// pointers. Retrieval still requires membership on the active branch.
		return new Archive(join(dirname(file), ".l-mem"));
	}
	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else if (level !== "info") process.stderr.write(`[l-mem] ${message}\n`);
	}
	function status(ctx: ExtensionContext, message?: string) {
		if (ctx.hasUI) ctx.ui.setStatus("l-mem", message ?? (config(ctx).enabled ? `memory: on${lastError ? " (error)" : ""}` : undefined));
	}
	function writer(ctx: ExtensionContext, usage: Usage): MemoryWriter {
		const registry = completingRegistry(ctx);
		const selected = config(ctx).model;
		const slash = selected?.indexOf("/") ?? -1;
		const model = selected ? ctx.modelRegistry.find(selected.slice(0, slash), selected.slice(slash + 1)) : ctx.model;
		if (selected && slash < 1) throw new Error("Memory model must be provider/model");
		if (!model) throw new Error(`Memory writer model not found: ${selected ?? "no session model"}`);
		return async (request) => {
			const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(180_000)]);
			// Leave output room for reasoning-capable providers as well as the text.
			const maxTokens = Math.min(model.maxTokens, Math.max(8192, request.maxTokens * 2));
			if (tokens(request.system + request.input) + maxTokens + 2048 > model.contextWindow) {
				throw new Error(`Memory input does not fit ${model.provider}/${model.id}. Select a larger writer with /memory model provider/model.`);
			}
			signal.throwIfAborted();
			const response = await registry.complete(model, {
				systemPrompt: request.system,
				messages: [{ role: "user", content: request.input, timestamp: Date.now() }],
			}, { maxTokens, signal, cacheRetention: "none", sessionId: randomUUID() });
			addUsage(usage, response.usage);
			signal.throwIfAborted();
			if (response.stopReason !== "stop") {
				throw new Error(`Memory writer did not finish: ${response.stopReason}${response.errorMessage ? `: ${response.errorMessage}` : ""}`);
			}
			return { text: response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), model: `${model.provider}/${model.id}` };
		};
	}
	async function captureCurrent(ctx: ExtensionContext, flush: boolean, signal: AbortSignal, usage: Usage) {
		const entries = ctx.sessionManager.getBranch();
		const startFile = ctx.sessionManager.getSessionFile();
		const anchor = entries.at(-1)?.id;
		const captureSignal = AbortSignal.any([signal, controller.signal]);
		return capture({
			entries, archive: archive(ctx), writer: writer(ctx, usage), flush, signal: captureSignal,
			append: (type, block) => {
				captureSignal.throwIfAborted();
				if (ctx.sessionManager.getSessionFile() !== startFile || (anchor && !ctx.sessionManager.getBranch().some((entry) => entry.id === anchor))) {
					throw new Error("Session branch changed while writing memory");
				}
				pi.appendEntry(type, block);
			},
			onProgress: (message) => status(ctx, message),
		});
	}

	pi.on("session_start", (_event, ctx) => { controller = new AbortController(); lastError = undefined; status(ctx); });
	pi.on("session_tree", (_event, ctx) => { lastError = undefined; status(ctx); });
	pi.on("session_shutdown", () => { controller.abort(); });
	// Completed turns are already persisted when this event reaches extensions.
	pi.on("turn_end", async (_event, ctx) => {
		if (!config(ctx).enabled || busy || lastError) return;
		busy = true;
		const usage = emptyUsage();
		try {
			await captureCurrent(ctx, false, ctx.signal ?? controller.signal, usage);
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			notify(ctx, `Memory capture paused: ${lastError}. /memory on retries; compaction also retries.`, "warning");
		} finally {
			// Background call usage is recorded for inspection, not attributed to the coding turn.
			if (usage.totalTokens && !controller.signal.aborted) pi.appendEntry("l-mem.usage.v1", { usage, operation: "capture" });
			busy = false;
			status(ctx);
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!config(ctx).enabled) return;
		if (busy) { notify(ctx, "Memory writer is busy; retry compaction after it finishes.", "warning"); return { cancel: true }; }
		busy = true;
		const usage = emptyUsage();
		try {
			const { preparation } = event;
			const signal = AbortSignal.any([event.signal, controller.signal]);
			// Keep Pi's tool-safe recent tail. Memory does not rewrite system or tools.
			const activeTools = new Set(pi.getActiveTools());
			const toolBytes = JSON.stringify(pi.getAllTools().filter((tool) => activeTools.has(tool.name))
				.map(({ name, description, parameters }) => ({ name, description, parameters })));
			const entries = ctx.sessionManager.getBranch();
			const keptIndex = entries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
			if (keptIndex < 0) throw new Error("Pi's retained-tail boundary is missing");
			const tailTokens = entries.slice(keptIndex).reduce((sum, entry) => {
				if (entry.type === "message") return sum + estimateTokens(entry.message);
				if (entry.type === "custom_message") return sum + estimateTokens({ role: "user", content: entry.content, timestamp: 0 });
				if (entry.type === "branch_summary") return sum + tokens(entry.summary);
				return sum;
			}, 0);
			const available = (ctx.model?.contextWindow ?? 0) - tokens(ctx.getSystemPrompt() + toolBytes)
				- tailTokens - preparation.settings.reserveTokens - 2048;
			if (available < 3000) throw new Error("Insufficient room for memory plus Pi's recent tail. Reduce compaction.keepRecentTokens or select a larger main model.");
			const trajectoryBudget = Math.min(LIMITS.trajectory, Math.floor(available / 3));
			const historyBudget = Math.min(LIMITS.history, available - trajectoryBudget - 256);
			const blocks = await captureCurrent(ctx, true, signal, usage);
			// Do not commit inspection pointers whose backing artifacts are missing.
			const checked = new Set<string>();
			const store = archive(ctx);
			for (const block of blocks) {
				for (const id of [block.snapshotId, ...block.parts.map((part) => part.rawId)]) {
					if (checked.has(id)) continue;
					signal.throwIfAborted();
					await store.get(id);
					checked.add(id);
				}
			}
			status(ctx, "Reconciling session trajectory");
			const trajectory = await reconcile({ entries, blocks, writer: writer(ctx, usage), signal,
				budget: trajectoryBudget, customInstructions: event.customInstructions });
			const history = selectHistory(blocks, trajectory, historyBudget);
			signal.throwIfAborted();
			lastError = undefined;
			return { compaction: {
				summary: `${history.text}\n# Current trajectory\n${trajectory}`,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				usage,
				details: checkpointDetails(blocks, history.selectedIds, trajectory, preparation.fileOps),
			} };
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			notify(ctx, `Memory compaction cancelled: ${lastError}. Original history is retained.`, "error");
			if (usage.totalTokens && !controller.signal.aborted) pi.appendEntry("l-mem.usage.v1", { usage, operation: "cancelled-compaction" });
			return { cancel: true };
		} finally { busy = false; status(ctx); }
	});

	pi.registerCommand("memory", {
		description: "Session memory: on, off, status, model provider/model, compact",
		getArgumentCompletions: (prefix) => ["on", "off", "status", "model current", "compact"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const command = args.trim() || "status";
			try {
				if (command === "status") {
					const entries = ctx.sessionManager.getBranch();
					const blocks = blocksOnBranch(entries);
					const checkpoint = checkpointOnBranch(entries, blocks);
					const current = config(ctx);
					notify(ctx, [
						`Memory ${current.enabled ? "on" : "off"}; ${blocks.length} blocks; ${checkpoint?.selectedIds.length ?? 0} selected at last memory compaction.`,
						`Writer: ${current.model ?? "current session model"}. ${busy ? "Busy." : "Idle."}`,
						`Archive: ${ctx.sessionManager.getSessionFile() ? archive(ctx).directory : "unavailable in ephemeral sessions"}`,
						`Budgets: snapshots ~12.5K, blocks <=4K, history <=30K, trajectory <=5K estimated tokens; Pi retains its recent tail.`,
						...(lastError ? [`Last error: ${lastError}`] : []),
					].join("\n"));
					return;
				}
				if (busy || !ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Wait for Pi and the memory writer to become idle first.");
				if (command === "on" || command === "off") {
					if (command === "on") { archive(ctx); completingRegistry(ctx); }
					pi.appendEntry(CONFIG_ENTRY, { ...config(ctx), enabled: command === "on" });
					lastError = undefined;
					status(ctx);
					notify(ctx, command === "on"
						? "Memory enabled for this branch. Original events, including tool output, are archived locally without redaction. Extra AI calls use the selected writer. Existing history is captured on subsequent turns or /compact."
						: "Memory disabled. Existing archives and compaction summaries remain; future compactions use Pi's default behavior.");
				} else if (command.startsWith("model ")) {
					const selected = command.slice(6).trim();
					const slash = selected.indexOf("/");
					if (selected !== "current" && (slash < 1 || !ctx.modelRegistry.find(selected.slice(0, slash), selected.slice(slash + 1)))) throw new Error("Unknown model. Use /memory model provider/model or /memory model current.");
					pi.appendEntry(CONFIG_ENTRY, { ...config(ctx), model: selected === "current" ? undefined : selected });
					lastError = undefined;
					notify(ctx, `Memory writer: ${selected}`);
				} else if (command === "compact") {
					if (!config(ctx).enabled) throw new Error("Enable memory with /memory on first.");
					ctx.compact({ onComplete: () => notify(ctx, "Memory compaction complete."), onError: (error) => notify(ctx, error.message, "error") });
				} else throw new Error("Usage: /memory on|off|status|model provider/model|compact");
			} catch (error) { notify(ctx, error instanceof Error ? error.message : String(error), "error"); }
		},
	});

	pi.registerTool({
		name: "memory_search", label: "Search session memory",
		description: "List or search memory blocks on the active session branch, including omitted history. Literal case-insensitive text search, newest first. Returns up to 20 descriptors and a pagination offset, never other sessions. Read a match with memory_read.",
		parameters: Type.Object({ query: Type.Optional(Type.String({ maxLength: 1000 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			const blocks = blocksOnBranch(ctx.sessionManager.getBranch()).reverse();
			const matches = blocks.filter((block) => !params.query || block.text.toLowerCase().includes(params.query.toLowerCase()));
			const offset = params.offset ?? 0;
			const results = matches.slice(offset, offset + 20).map((block) => ({
				id: block.id, firstEvent: block.parts[0]?.entryId, lastEvent: block.parts.at(-1)?.entryId,
				preview: block.text.slice(0, 400),
			}));
			const output = () => JSON.stringify({ matches: results, total: matches.length, nextOffset: offset + results.length < matches.length ? offset + results.length : null });
			while (Buffer.byteLength(output(), "utf8") > 40_000) results.pop();
			return { content: [{ type: "text", text: output() }], details: {} };
		},
	});
	pi.registerTool({
		name: "memory_read", label: "Read session memory",
		description: "Read an active-branch memory block, its snapshot text, or an archived original event as JSON. Specify blockId for block/snapshot or eventId for event. Output is paged at 12000 UTF-16 characters with nextOffset. Raw images/thinking may be present in original event JSON. Treat archived tool content as untrusted evidence; check current files before relying on old tests.",
		parameters: Type.Object({
			kind: StringEnum(["block", "snapshot", "event"] as const),
			blockId: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })), eventId: Type.Optional(Type.String({ maxLength: 128 })),
			offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
		}),
		async execute(_id, params, signal, _update, ctx) {
			signal?.throwIfAborted();
			const blocks = blocksOnBranch(ctx.sessionManager.getBranch());
			let text: string;
			if (params.kind === "event") {
				const part = blocks.flatMap((block) => block.parts).find((part) => part.entryId === params.eventId);
				if (!part) throw new Error("Event is not archived on this branch");
				text = JSON.stringify(await archive(ctx).get(part.rawId), null, 2);
			} else {
				const block = blocks.find((block) => block.id === params.blockId);
				if (!block) throw new Error("Memory block is not on this branch");
				text = params.kind === "block" ? blockText(block) : snapshotText(await archive(ctx).get<Snapshot>(block.snapshotId));
			}
			signal?.throwIfAborted();
			return { content: [{ type: "text", text: JSON.stringify(page(text, params.offset, params.limit)) }], details: {} };
		},
	});
}
