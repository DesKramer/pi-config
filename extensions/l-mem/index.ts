import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { DerivedUpdate } from "./contracts.ts";
import { dirname, join } from "node:path";
import { SessionMemory, formatStatus } from "./memory.ts";
import { SqliteStore, digest, failure } from "./storage.ts";
import { captureBranch, piMemoryModel, piShadowHost, shadowTokenizer, type PiCaptureState } from "./pi-adapter.ts";
import { getPiMemoryHost } from "./host-runtime.ts";
import { nativeHost, nativeTokenizer } from "./native-context.ts";
import { requireAcceptance } from "./acceptance.ts";

type LiveMode = "enabled" | "experimental";
type Mode = "off" | "shadow" | LiveMode;
function isLive(mode: Mode): mode is LiveMode { return mode === "enabled" || mode === "experimental"; }
const EXPERIMENTAL_WARNING = "EXPERIMENTAL live memory: no passing behavioral report required. Memory can time out or mishandle information. Use a fresh session with disposable work. Memory generation uses additional model quota. Runtime safety checks remain active; this is not release acceptance.";

export default function lMem(pi: ExtensionAPI) {
	pi.registerFlag("l-mem", { description: "l-mem mode: off, shadow, enable or experimental. Enable requires acceptance; experimental explicitly opts into unvalidated live replacement. Both require the checked private runtime.", type: "string", default: "off" });
	let mode: Mode = "off", started = false;
	let store: SqliteStore | undefined, memory: SessionMemory | undefined, sessionId = "", boundModel = "";
	let capture: PiCaptureState = { entryIds: [], eventIds: new Map() };
	let lifetime = new AbortController();
	let work: Promise<unknown> | undefined;
	let failureText: string | undefined;
	const notify = (ctx: ExtensionContext, text: string, error = false) => {
		const clean = stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
		if (ctx.hasUI) ctx.ui.notify(clean, error ? "error" : "info");
		else console.error(clean);
	};
	const modeIndicator = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus("l-mem", mode === "experimental" ? "l-mem EXPERIMENTAL: unvalidated live memory" : undefined);
	};
	function initialize(ctx: ExtensionContext) {
		if (memory) return;
		const file = ctx.sessionManager.getSessionFile();
		if (!file) throw new Error("UNSUPPORTED_HOST_CAPABILITY: l-mem requires a durable session; --no-session remains non-persistent.");
		if (!pi.getActiveTools().includes("read")) throw new Error("UNSUPPORTED_HOST_CAPABILITY: the existing read tool must be active to resolve memory archives.");
		const directory = join(dirname(file), "l-mem");
		store = new SqliteStore(directory); sessionId = ctx.sessionManager.getSessionId();
		const host = getPiMemoryHost(sessionId);
		const binding = host ? nativeHost(store, sessionId, join(directory, digest(sessionId))) : piShadowHost(join(directory, digest(sessionId)));
		if (host) binding.dispatch = host.binding();
		memory = new SessionMemory(store, host ? nativeTokenizer : shadowTokenizer, binding, piMemoryModel(ctx, lifetime.signal));
		boundModel = `${ctx.model?.provider}/${ctx.model?.id}`;
		host?.attach(store, memory, () => captureBranch(memory!, sessionId, ctx.sessionManager.getBranch(), capture));
		const saved = store.load(sessionId).state.events.filter(e => e.producerEventId.startsWith("entry:"));
		capture = { entryIds: saved.map(e => e.producerEventId.slice(6)), eventIds: new Map(saved.map(e => [e.producerEventId.slice(6), e.id])) };
	}
	function sync(ctx: ExtensionContext) {
		if (mode === "off" || capture.blockedReason) return;
		try {
			initialize(ctx);
			captureBranch(memory!, sessionId, ctx.sessionManager.getBranch(), capture);
			if (!work) {
				work = memory!.advanceMemory(sessionId).then(result => { if (!result.ok) failureText = `${result.code}: ${result.message}`; }).finally(() => { work = undefined; });
			}
		} catch (error) { failureText = failure(error).message; capture.blockedReason = failureText; notify(ctx, failureText, true); }
	}
	pi.on("session_start", async (event, ctx) => {
		// Pi applies CLI flag values after loading extension factories.
		if (!started) {
			started = true;
			const startupMode = pi.getFlag("l-mem");
			mode = startupMode === "enable" ? "enabled" : startupMode === "experimental" ? "experimental" : startupMode === "shadow" ? "shadow" : "off";
		}
		// The startup flag is explicit consent for the initial session only, not /reload or another session.
		if (mode === "experimental" && (event as { reason?: string }).reason !== "startup") {
			mode = "off"; notify(ctx, "Experimental memory is OFF. Use /l-mem experimental to opt in for this session.");
		}
		modeIndicator(ctx);
		if (!isLive(mode)) { sync(ctx); return; }
		try { await enable(ctx, mode); }
		catch (error) { mode = "off"; modeIndicator(ctx); failureText = failure(error).message; notify(ctx, `l-mem live startup failed; memory is OFF. ${failureText}`, true); }
	});
	async function enable(ctx: ExtensionContext, requestedMode: LiveMode) {
		if (!ctx.model) throw new Error("UNSUPPORTED_HOST_CAPABILITY: select a main model before enabling memory");
		const identity = `${ctx.model.provider}/${ctx.model.id}`;
		// Only an explicit experimental request skips this check. Never infer it from current mode or a failed report.
		if (requestedMode === "enabled") requireAcceptance(process.env.L_MEM_ACCEPTANCE_REPORT, identity);
		const targetSession = ctx.sessionManager.getSessionId(), activeLifetime = lifetime;
		const host = getPiMemoryHost(targetSession);
		if (!host) throw new Error("UNSUPPORTED_HOST_CAPABILITY: start pi with scripts/l-mem-pi.ts and a durable, provenance-tagged session");
		if (!ctx.isIdle()) throw new Error("Abort or finish the active turn before enabling live memory");
		if (memory && boundModel !== identity) throw new Error("UNSUPPORTED_HOST_CAPABILITY: main model changed. Turn l-mem off before enabling it again so its memory writer is rebound too.");
		await work;
		if (activeLifetime !== lifetime || activeLifetime.signal.aborted || targetSession !== ctx.sessionManager.getSessionId() || identity !== `${ctx.model?.provider}/${ctx.model?.id}` || !ctx.isIdle()) throw new Error("REVISION_CONFLICT: session or model changed while enabling memory");
		if (requestedMode === "experimental") notify(ctx, EXPERIMENTAL_WARNING);
		const created = !memory;
		try {
			initialize(ctx);
			if (capture.blockedReason) throw new Error(capture.blockedReason);
			captureBranch(memory!, sessionId, ctx.sessionManager.getBranch(), capture);
			host.enable(); mode = requestedMode; failureText = undefined; modeIndicator(ctx); sync(ctx);
		} catch (error) {
			if (created) { host.detach(); store?.close(); store = undefined; memory = undefined; capture = { entryIds: [], eventIds: new Map() }; }
			throw error;
		}
		notify(ctx, `l-mem ${requestedMode === "experimental" ? "EXPERIMENTAL live replacement" : "replacement"} enabled. Original history remains archived. Failed preparation or unresolved dispatch stops the request instead of falling back to ordinary compaction.`);
	}
	pi.on("context", (_event, ctx) => { sync(ctx); /* Never change live messages in shadow mode. */ });
	pi.on("tool_call", (_event, ctx) => { sync(ctx); /* pi has durably recorded the assistant call at this hook. */ });
	pi.on("agent_end", (_event, ctx) => { sync(ctx); });
	pi.on("tool_execution_end", (event, ctx) => {
		if (mode === "off" || !memory || capture.blockedReason) return;
		const recorded = memory.recordEvent(sessionId, `operation-end:${event.toolCallId}`, { kind: "operation_status", producer: event.toolName, authority: "host", origin: "original", timestamp: Date.now(), payload: JSON.stringify({ toolCallId: event.toolCallId, isError: event.isError }), causalParentIds: [], deliveryState: "delivered", toolCallId: event.toolCallId, operationId: event.toolCallId, operationStatus: event.isError ? "failed" : "completed", observationScope: "Pi tool lifecycle completion, not feature acceptance or workspace verification." });
		if (!recorded.ok) { failureText = `${recorded.code}: ${recorded.message}`; notify(ctx, failureText, true); }
	});
	pi.on("input", (event, ctx) => {
		if (mode !== "off" && event.source === "extension" && !getPiMemoryHost(sessionId)) {
			capture.blockedReason = "UNSUPPORTED_HOST_CAPABILITY: synthetic user input lacks durable origin metadata in pi session entries. Shadow generation paused.";
			notify(ctx, capture.blockedReason, true);
		}
	});
	pi.on("session_tree", (_event, ctx) => { sync(ctx); });
	pi.on("session_shutdown", async (_event, ctx) => {
		if (mode === "experimental") mode = "off";
		modeIndicator(ctx);
		lifetime.abort(); await work; getPiMemoryHost(sessionId)?.detach(); store?.close(); store = undefined; memory = undefined; work = undefined;
		lifetime = new AbortController(); capture = { entryIds: [], eventIds: new Map() };
	});
	pi.registerCommand("l-mem", {
		description: "Session trajectory memory: enable requires acceptance; experimental opts into unvalidated live replacement. Status is read-only; off stops capture and replacement.",
		getArgumentCompletions: prefix => ["status", "shadow", "off", "prepare", "enable", "experimental", "compact", "resolve", "regenerate", "reconcile"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
		async handler(args, ctx) {
			const command = args.trim() || "status";
			if (command === "enable" || command === "experimental") {
				try { await enable(ctx, command === "experimental" ? "experimental" : "enabled"); } catch (error) { failureText = failure(error).message; notify(ctx, failureText, true); }
				return;
			}
			if (command === "compact" || command.startsWith("resolve ")) {
				const host = getPiMemoryHost(sessionId);
				if (!host || !memory) { notify(ctx, "No attached native memory host. Start the private runtime and use /l-mem enable with acceptance, or /l-mem experimental for unvalidated live memory.", true); return; }
				try {
					if (command === "compact") {
						if (!isLive(mode)) throw new Error("Live replacement must be enabled before requesting compaction.");
						host.requestCompaction(); notify(ctx, "Compaction requested for the next model boundary.");
					} else {
						const [, id, ...reason] = command.split(/\s+/);
						host.resolve(id, reason.join(" "));
						notify(ctx, "Dispatch resolution recorded. No request or tool was replayed.");
					}
				} catch (error) { notify(ctx, String(error), true); }
				return;
			}
			if (command.startsWith("regenerate ") || command.startsWith("reconcile ")) {
				if (mode === "off") { notify(ctx, "Enable shadow capture before requesting a derived update.", true); return; }
				sync(ctx); await work;
				if (!memory || capture.blockedReason) { notify(ctx, capture.blockedReason ?? "Memory unavailable", true); return; }
				try {
					let request: DerivedUpdate;
					if (command.startsWith("regenerate ")) request = { kind: "regenerate_block", blockId: command.slice(11).trim() };
					else { const path = command.slice(10).trim(); if (statSync(path).size > 1000000) throw new Error("Reconciliation request exceeds 1 MB"); request = JSON.parse(readFileSync(path, "utf8")); if (request.kind !== "reconcile") throw new Error("Expected a reconcile request"); }
					const update = memory.advanceMemory(sessionId, request); work = update;
					const result = await update; if (work === update) work = undefined;
					notify(ctx, result.ok ? `Derived version ${result.value.derivedId} published. Original history and earlier versions retained.` : `${result.code}: ${result.message}`, !result.ok);
				} catch (error) { notify(ctx, String(error), true); }
				return;
			}
			if (command === "off") { mode = "off"; modeIndicator(ctx); lifetime.abort(); await work; getPiMemoryHost(sessionId)?.detach(); work = undefined; memory = undefined; store?.close(); store = undefined; lifetime = new AbortController(); capture = { entryIds: [], eventIds: new Map() }; failureText = undefined; notify(ctx, "l-mem off. Archives retained; live context unchanged."); return; }
			if (command === "shadow") { getPiMemoryHost(sessionId)?.disable(); mode = "shadow"; modeIndicator(ctx); sync(ctx); if (capture.blockedReason) { notify(ctx, capture.blockedReason, true); return; } notify(ctx, "l-mem shadow recording enabled. Memory generation uses separate model calls when supported. Live context and ordinary pi compaction are unchanged."); return; }
			if (command === "prepare") {
				if (mode === "off") { notify(ctx, "Run /l-mem shadow first. No memory jobs or archive writes were started.", true); return; }
				sync(ctx); await work;
				if (!memory || !store || capture.blockedReason) { notify(ctx, capture.blockedReason ?? failureText ?? "Memory unavailable", true); return; }
				if (!ctx.model) { notify(ctx, "UNSUPPORTED_HOST_CAPABILITY: no active model", true); return; }
				const events = store.load(sessionId).state.events;
				const lastAgent = events.filter(e => e.kind === "agent_message" && e.origin === "original").at(-1)?.sequence ?? 0;
				const preparation = memory.prepareCompaction(sessionId, { requestId: `shadow:${ctx.sessionManager.getLeafId()}`, contextRevision: ctx.sessionManager.getLeafId() ?? "root", capacity: ctx.model.contextWindow, fixedTokens: shadowTokenizer.count(ctx.getSystemPrompt() + JSON.stringify(pi.getAllTools())), outputReserve: Math.min(ctx.model.maxTokens, 16_000), safetyMargin: 4_000, unactedUserEventIds: events.filter(e => e.kind === "user_message" && e.origin === "original" && e.sequence > lastAgent).map(e => e.id) });
				work = preparation;
				const activeLifetime = lifetime;
				const result = await preparation;
				if (work === preparation) work = undefined;
				if (activeLifetime.signal.aborted) return;
				notify(ctx, result.ok ? `Shadow handoff ${result.value.id}\n${result.value.payloadRef}\nEstimated inclusive tokens: ${result.value.rendered.counts.total}. Not activated; provider serialization and dispatch are not certified.` : `${result.code}: ${result.message}`, !result.ok); return;
			}
			if (command !== "status") { notify(ctx, "Usage: /l-mem status|shadow|off|prepare|enable|experimental|compact|resolve <id> <reason>|regenerate <block-id>|reconcile <file>", true); return; }
			// Status observes recorded state. It must not start generation, flush a
			// snapshot, wait for a model, or add a message to the agent's context.
			const detail = memory ? formatStatus(memory.inspect(sessionId)) : "Archive not open; block status unavailable.\nNext block: not scheduled while capture is off or unavailable.\nUse /l-mem enable in the private runtime with a passing report, or explicitly opt into unvalidated live memory with /l-mem experimental. Shadow is optional debugging, not agent-usable memory.";
			const problem = capture.blockedReason ?? failureText;
			notify(ctx, ["l-mem status", `Mode: ${mode}${mode === "shadow" ? "; recording only, live replacement off" : mode === "experimental" ? "; LIVE replacement, acceptance gate bypassed by explicit opt-in, NOT release-validated" : ""}.`,
				`Capture: ${capture.blockedReason ? "paused" : memory && mode !== "off" ? "active" : "off"}. Background pass: ${work ? "in progress" : "idle"}.`,
				detail, ...(problem ? [`Capture/background diagnostic: ${problem.replace(/\s+/g, " ").slice(0, 400)}`] : [])].join("\n"));
		},
	});
}
