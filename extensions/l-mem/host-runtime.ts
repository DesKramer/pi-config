import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { observeWorkspace, fileSnapshot, workspaceArtifacts, executionScope } from "./workspace.ts";
import type { WorkspaceObservation } from "./workspace.ts";
import type { ContextRequest, Handoff, HostBinding, Json, Store } from "./contracts.ts";
import { canonical, digest, fail, json, readJson, saveJson, update } from "./storage.ts";
import { nativeTokenizer, textOnly } from "./native-context.ts";
import { receiptKeys, reasoningAccounting, type ProviderReceipt } from "./reasoning.ts";
import type { SessionMemory } from "./memory.ts";

interface DispatchRecord { id: string; handoffId: string; preparationId: string; watermark: number; payloadRef: string; fixedDigest: string; state: "accepted" | "sent" | "complete" | "resolved"; providerPayloadRef?: string; providerResponseRef?: string; preparationMs?: number; sentAt?: number; completedAt?: number; resolution?: string }
export interface HostState { version: 1; revision: number; responses?: ProviderReceipt[]; owner?: { pid: number; hostname: string; id: string }; dispatches: DispatchRecord[]; queued: { id: string; mode: "steer" | "followUp"; message: Json; delivered: boolean }[] }
const registryKey = Symbol.for("l-mem.sdk-host-v1");
const registry: Map<string, PiMemoryHost> = (globalThis as any)[registryKey] ??= new Map();
export function getPiMemoryHost(sessionId: string): PiMemoryHost | undefined {
	const host = [...new Set(registry.values())].find(h => h.sessionId === sessionId);
	if (host) { for (const [key, value] of registry) if (value === host) registry.delete(key); registry.set(sessionId, host); }
	return host;
}
function validateOriginalInputs(messages: any[]): void {
	textOnly(messages);
	for (const message of messages) if (message.role === "user") {
		const shown = typeof message.content === "string" ? message.content : message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
		if (message.lMemInput?.source !== "extension" && message.lMemInput?.rawText !== shown) fail("UNSUPPORTED_HOST_CAPABILITY", "Expanded or transformed input needs an authority-preserving host profile. Its original and expanded forms remain archived; use ordinary pi or a fresh plain-input session.");
	}
}
function hostState(state: { host?: HostState }): HostState {
	if (state.host && state.host.version !== 1) fail("UNSUPPORTED_SCHEMA", "Unsupported host dispatch schema");
	return state.host ??= { version: 1, revision: 0, dispatches: [], queued: [] };
}
function alive(owner: NonNullable<HostState["owner"]>): boolean {
	if (owner.hostname !== hostname()) return true;
	try { process.kill(owner.pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** The pinned pi host patch calls this once, before extension session_start.
 * No files or model jobs are opened until the extension attaches a memory store.
 */
export function installPiMemoryHost(session: any, convert: (messages: any[]) => any[]): PiMemoryHost {
	return new PiMemoryHost(session, convert);
}
export class PiMemoryHost {
	readonly version = "pi-0.85.1-dispatch-v3";
	private session: any;
	private convert: (messages: any[]) => any[];
	private owner = randomUUID();
	private queueRevision = 0;
	private store?: Store;
	private memory?: SessionMemory;
	private capture?: () => void;
	private live = false;
	private enabledModel?: string;
	private attachedSessionId?: string;
	private enqueued = new Set<string>();
	get sessionId(): string { return this.session.sessionManager.getSessionId(); }
	private pending?: string;
	private fixedDigest = "";
	private originalSettings?: { compaction: boolean; retry: boolean };
	private force = false;
	private executions = new Map<string, Json>();
	private before = new Map<string, { workspace: WorkspaceObservation; files: import("./contracts.ts").ArtifactInput[] }>();
	constructor(session: any, convert: (messages: any[]) => any[]) {
		this.session = session; this.convert = convert;
		const sessionId = session.sessionManager.getSessionId(), cwd = session.sessionManager.getCwd();
		registry.set(sessionId, this);
		const append = session.sessionManager.appendMessage.bind(session.sessionManager);
		session.sessionManager.appendMessage = (message: any) => {
			const result = append(message);
			const sessionId = this.attachedSessionId!;
			this.enqueued.delete(message.lMemInput?.id ?? digest(message));
			this.capture?.();
			if (this.store && message.lMemInput?.id) update(this.store, sessionId, state => { const queued = hostState(state).queued.find(q => q.id === message.lMemInput.id); if (queued) queued.delivered = true; });
			if (this.store && message.role === "assistant" && this.pending) {
				update(this.store, sessionId, state => { const record = hostState(state).dispatches.find(d => d.id === this.pending); if (record?.state === "sent" && record.providerPayloadRef && !["error", "aborted"].includes(message.stopReason)) { record.state = "complete"; record.completedAt = Date.now(); } });
				this.pending = undefined;
			}
			return result;
		};
		for (const mode of ["steer", "followUp"] as const) {
			const enqueue = session.agent[mode].bind(session.agent);
			session.agent[mode] = (message: any) => {
				const id = message.lMemInput?.id ?? digest(message), sessionId = this.attachedSessionId!;
				if (this.store) update(this.store, sessionId, state => {
					const previous = hostState(state).queued.find(q => q.id === id);
					if (previous && canonical(previous.message) !== canonical(message)) fail("DUPLICATE_EVENT_CONFLICT", "Queued input identity was reused for different content");
					if (!previous) hostState(state).queued.push({ id, mode, message: json(message), delivered: false });
				});
				if (this.enqueued.has(id)) return;
				this.enqueued.add(id); this.queueRevision++;
				return enqueue(message);
			};
		}
		const beforeTool = session.agent.beforeToolCall;
		session.agent.beforeToolCall = async (call: any, signal: AbortSignal) => {
			if (this.live && this.store && hostState(this.store.load(this.attachedSessionId!).state).dispatches.some(d => d.state === "accepted" || d.state === "sent")) return { block: true, reason: "The model request has no definite journaled completion. Resolve it before executing tools." };
			const result = await beforeTool?.(call, signal);
			if (this.memory && !result?.block) {
				this.capture?.();
				this.before.set(call.toolCall.id, { workspace: observeWorkspace(cwd), files: fileSnapshot(cwd, call.args) });
			}
			return result;
		};
		const afterTool = session.agent.afterToolCall;
		session.agent.afterToolCall = async (call: any, signal: AbortSignal) => {
			const result = await afterTool?.(call, signal);
			if (!this.memory || !this.store) return result;
			const sessionId = this.attachedSessionId!;
			const before = this.before.get(call.toolCall.id);
			if (!before) return result;
			const after = observeWorkspace(cwd), execution = this.executions.get(call.toolCall.id);
			const scope = executionScope(call.toolCall.name, before.workspace, after, execution);
			const artifacts = [...workspaceArtifacts(before.workspace, after), ...before.files, ...fileSnapshot(cwd, call.args)];
			const fullOutputPath = (execution as any)?.fullOutputPath;
			// Only the pinned native bash implementation can supply this locator.
			if (typeof fullOutputPath === "string") artifacts.push({ content: readFileSync(fullOutputPath).toString("base64"), encoding: "base64", mediaType: "text/plain", captureKind: "auxiliary_capture", completeness: "complete", externalLocator: fullOutputPath });
			const originalEvidenceIds = typeof call.args?.path === "string" ? this.store.load(sessionId).state.artifacts.filter(a => a.storageRef === call.args.path).flatMap(a => a.eventIds) : [];
			const observation = this.memory.recordEvent(sessionId, `workspace:${call.toolCall.id}`, { kind: before.workspace.version === after.version ? "operation_status" : "workspace_change", producer: "pi-host", authority: "host", origin: "original", timestamp: Date.now(), payload: canonical({ tool: call.toolCall.name, arguments: call.args, execution, before: before.workspace.version, after: after.version }), artifacts, causalParentIds: [], deliveryState: "delivered", operationId: call.toolCall.id, operationStatus: (result?.isError ?? call.isError) ? "failed" : "completed", workspaceVersion: after.complete ? after.version : undefined, observationScope: scope, originalEvidenceIds });
			if (!observation.ok) fail(observation.code, observation.message);
			this.before.delete(call.toolCall.id); this.executions.delete(call.toolCall.id);
			return { ...result, details: { ...(result?.details ?? call.result.details ?? {}), lMemEvidence: { sourceEventId: observation.value.id, workspaceVersion: before.workspace.complete && after.complete && before.workspace.version === after.version ? after.version : undefined, observationScope: scope, originalEvidenceIds } } };
		};
		const dispose = session.dispose.bind(session);
		session.dispose = () => { this.detach(); for (const [key, value] of registry) if (value === this) registry.delete(key); this.enqueued.clear(); return dispose(); };
		const stream = session.agent.streamFunction.bind(session.agent);
		session.agent.streamFunction = (model: any, context: any, options: any) => this.runRequest(model, context, options, stream);
	}
	attach(store: Store, memory: SessionMemory, capture: () => void): void {
		if (this.store) this.disable();
		if (this.attachedSessionId && this.attachedSessionId !== this.sessionId) this.enqueued.clear();
		this.attachedSessionId = this.sessionId; this.store = store; this.memory = memory; this.capture = capture;
	}
	detach(): void { this.disable(); this.capture = undefined; this.memory = undefined; this.store = undefined; this.before.clear(); this.executions.clear(); }
	binding(): NonNullable<HostBinding["dispatch"]> {
		return { activate: (sessionId, preparationId, revision, refresh) => {
			if (!this.live || !this.store) return { ok: false, code: "UNSUPPORTED_HOST_CAPABILITY", message: "Live host is not enabled", retryable: false };
			if (sessionId !== this.attachedSessionId || sessionId !== this.sessionId) return { ok: false, code: "REVISION_CONFLICT", message: "Dispatch belongs to a different session", retryable: true };
			const current = hostState(this.store.load(sessionId).state);
			const existing = current.dispatches.find(d => d.preparationId === preparationId);
			if (existing) return { ok: true, value: { dispatchId: existing.id, handoff: this.handoff(existing.handoffId), state: existing.state === "accepted" ? "accepted" : "unknown" } };
			if (revision !== String(current.revision) || current.owner?.id !== this.owner) return { ok: false, code: "REVISION_CONFLICT", message: "Host revision or owner changed", retryable: true };
			const refreshed = refresh(); if (!refreshed.ok) return refreshed;
			const record: DispatchRecord = { id: randomUUID(), handoffId: refreshed.value.id, preparationId, watermark: refreshed.value.watermark, payloadRef: refreshed.value.payloadRef, fixedDigest: this.fixedDigest, state: "accepted" };
			update(this.store, sessionId, state => {
				const host = hostState(state);
				if (String(host.revision) !== revision || host.owner?.id !== this.owner) fail("REVISION_CONFLICT", "Concurrent dispatch selection");
				host.revision++; host.dispatches.push(record);
			});
			return { ok: true, value: { dispatchId: record.id, handoff: refreshed.value, state: "accepted" } };
		} };
	}
	enable(): void {
		const selected = this.session.agent.state.model;
		const identity = selected && `${selected.provider}/${selected.id}/${selected.api}`;
		if (!identity) fail("UNSUPPORTED_HOST_CAPABILITY", "Select a main model before enabling memory");
		if (this.live) {
			if (identity !== this.enabledModel) fail("UNSUPPORTED_HOST_CAPABILITY", "Main model changed. Turn l-mem off and enable it again with acceptance for the new model.");
			return;
		}
		if (!this.store || !this.memory) fail("UNSUPPORTED_HOST_CAPABILITY", "Memory is not attached to the host");
		const id = this.attachedSessionId!;
		if (id !== this.sessionId) fail("REVISION_CONFLICT", "Attach the new session before enabling memory");
		if (this.session.sessionManager.getBranch().some((e: any) => e.type === "message" && e.message.role === "user" && !e.message.lMemInput?.source)) fail("UNSUPPORTED_HOST_CAPABILITY", "This history lacks durable user-input provenance. Start a new session with the patched host; old evidence was not relabeled");
		update(this.store, id, state => {
			const host = hostState(state);
			if (host.owner && host.owner.id !== this.owner && alive(host.owner)) fail("REVISION_CONFLICT", "Another process owns this session's dispatch");
			if (host.dispatches.some(d => d.state === "accepted" || d.state === "sent")) fail("REVISION_CONFLICT", "An earlier request may have been sent. Inspect /l-mem status and explicitly resolve its dispatch before continuing; no request was replayed");
			host.owner = { pid: process.pid, hostname: hostname(), id: this.owner };
		});
		if (!this.originalSettings) this.originalSettings = { compaction: this.session.settingsManager.getCompactionSettings().enabled, retry: this.session.settingsManager.getRetrySettings().enabled };
		this.session.settingsManager.applyOverrides({ compaction: { enabled: false }, retry: { enabled: false } });
		this.enabledModel = identity; this.live = true;
		// Requeue only inputs without a durable delivery record. This never starts
		// an agent run and never replays tool requests or model responses.
		const delivered = new Set(this.session.sessionManager.getBranch().filter((e: any) => e.type === "message").map((e: any) => e.message.lMemInput?.id));
		for (const queued of hostState(this.store.load(id).state).queued) if (!queued.delivered && !delivered.has(queued.id)) this.session.agent[queued.mode](queued.message);
	}
	disable(): void {
		this.live = false; this.enabledModel = undefined;
		if (this.originalSettings) this.session.settingsManager.applyOverrides({ compaction: { enabled: this.originalSettings.compaction }, retry: { enabled: this.originalSettings.retry } });
		this.originalSettings = undefined;
		if (this.store) update(this.store, this.attachedSessionId!, state => { if (hostState(state).owner?.id === this.owner) delete hostState(state).owner; });
	}
	recordExecution(toolCallId: string, execution: unknown): void { if (this.memory) this.executions.set(toolCallId, json(execution)); }
	requestCompaction(): void { this.force = true; }
	resolve(dispatchId: string, explanation: string): void {
		if (!this.store || !explanation.trim()) fail("INVALID_EVENT", "A dispatch resolution requires an operator explanation");
		if (this.session.isStreaming) fail("MEMORY_PENDING", "Abort or finish the active turn before resolving an uncertain dispatch");
		update(this.store, this.attachedSessionId!, state => {
			const record = hostState(state).dispatches.find(d => d.id === dispatchId);
			if (!record) fail("NOT_FOUND", "Dispatch not found");
			if (record.state === "resolved") { if (record.resolution === explanation) return; fail("REVISION_CONFLICT", "A different resolution is already recorded"); }
			if (record.state === "complete") fail("REVISION_CONFLICT", "This request already has a definite completion");
			record.state = "resolved"; record.resolution = explanation;
		});
	}
	private handoff(id: string): Handoff {
		const handoff = this.store!.load(this.attachedSessionId!).state.handoffs.find(h => h.id === id);
		if (!handoff) fail("MISSING_ARTIFACT", "Dispatch points to a missing handoff");
		this.store!.read(handoff.sessionId, handoff.payloadRef); return handoff;
	}
	private async observeResponse(model: any, context: any, options: any, invoke: any, dispatchId?: string): Promise<any> {
		const store = this.store, sessionId = this.attachedSessionId;
		const response = await invoke(model, context, options);
		if (!store || !sessionId) return response;
		const host = this;
		let result: Promise<any> | undefined;
		return {
			async result() {
				result ??= (async () => {
					const message = structuredClone(await response.result());
					if (host.store !== store || host.attachedSessionId !== sessionId || host.sessionId !== sessionId) return message;
					const responseRef = saveJson(store, sessionId, { model: { provider: model.provider, id: model.id, api: model.api }, message });
					update(store, sessionId, state => {
						const journal = hostState(state);
						journal.responses ??= [];
						if (!journal.responses.some(r => r.responseRef === responseRef)) journal.responses.push({ responseRef, reasoningKeys: receiptKeys(message) });
						const dispatch = journal.dispatches.find(d => d.id === dispatchId);
						if (dispatch) dispatch.providerResponseRef = responseRef;
					});
					return message;
				})();
				return structuredClone(await result);
			},
			async *[Symbol.asyncIterator]() {
				// Isolate provider usage from mutations through streamed partials.
				for await (const event of response) yield structuredClone(event);
			},
		};
	}
	private async runRequest(model: any, context: any, options: any, invoke: any): Promise<any> {
		if (!this.live) return this.observeResponse(model, context, options, invoke);
		if (`${model.provider}/${model.id}/${model.api}` !== this.enabledModel) fail("UNSUPPORTED_HOST_CAPABILITY", "Main model changed. Turn l-mem off and enable it again with acceptance for the new model.");
		if (!options?.lMemBoundary || typeof options.getSteeringMessages !== "function") fail("UNSUPPORTED_HOST_CAPABILITY", "The versioned request-boundary patch is missing");
		if (!["openai-responses", "openai-codex-responses", "openai-completions"].includes(model.api)) fail("UNSUPPORTED_HOST_CAPABILITY", `Native conversation-data envelope not certified for ${model.api}`);
		const preparationStarted = Date.now();
		const store = this.store!, memory = this.memory!, sessionId = this.attachedSessionId!;
		if (sessionId !== this.sessionId) fail("REVISION_CONFLICT", "Session changed before request dispatch");
		const unknown = hostState(store.load(sessionId).state).dispatches.find(d => ["sent", "accepted"].includes(d.state));
		if (unknown) fail("REVISION_CONFLICT", `Possibly dispatched request ${unknown.id} requires explicit resolution`);
		textOnly(context.messages);
		validateOriginalInputs(options.lMemBoundary.context.messages);
		// Capture before provider invocation. Context hooks may not silently inject
		// unaudited messages or change the recorded tail in live mode.
		const expected = this.convert(options.lMemBoundary.context.messages);
		if (canonical(expected) !== canonical(context.messages)) fail("UNSUPPORTED_HOST_CAPABILITY", "A context extension changed source messages. Record its output with durable provenance before using l-mem replacement");
		let request: ContextRequest, handoff: Handoff;
		for (let round = 0; ; round++) {
			options.signal?.throwIfAborted();
			if (round >= 16) fail("MEMORY_PENDING", "Continuous steering prevented a stable dispatch; all accepted inputs remain queued or archived");
			const queueRevision = this.queueRevision;
			const arrivals = await options.getSteeringMessages();
			for (const message of arrivals) {
				await options.lMemBoundary.emit({ type: "message_start", message });
				await options.lMemBoundary.emit({ type: "message_end", message });
				options.lMemBoundary.context.messages.push(message);
			}
			if (!this.live || this.store !== store || this.attachedSessionId !== sessionId) fail("REVISION_CONFLICT", "Host attachment changed while preparing dispatch");
			this.capture!();
			validateOriginalInputs(options.lMemBoundary.context.messages);
			const state = store.load(sessionId).state;
			const lastAgent = state.events.filter(e => e.kind === "agent_message" && e.authority === "agent").reverse().find(e => !e.messageRef || !["error", "aborted"].includes((readJson(store, sessionId, e.messageRef) as any).stopReason))?.originalSequence ?? 0;
			// Includes unconsumed user-bash results and late operation results,
			// not only results belonging to the most recent model's tool calls.
			const exactTailEventIds = state.events.filter(e => e.kind === "tool_result" && e.originalSequence! > lastAgent).map(e => e.id);
			const fixed = { systemPrompt: context.systemPrompt, tools: (context.tools ?? []).map((t: any) => ({ name: t.name, description: t.description, parameters: t.parameters })) };
			this.fixedDigest = digest(fixed);
			request = { requestId: randomUUID(), contextRevision: String(hostState(state).revision), capacity: model.contextWindow,
				// Codex ignores maxTokens; reserve its declared model output limit.
				fixedTokens: nativeTokenizer.count(canonical(fixed)), outputReserve: model.api === "openai-codex-responses" ? model.maxTokens : Math.min(model.maxTokens, options.maxTokens ?? 16_000), safetyMargin: 4096,
				unactedUserEventIds: state.events.filter(e => e.kind === "user_message" && e.originalSequence! > lastAgent).map(e => e.id), exactTailEventIds };
			// Even before the first compaction, use a C=0 handoff so dispatch and
			// recovery follow the same transaction. No special unjournaled first send.
			const originalSize = state.events.reduce((n, e) => n + (e.originalSequence ? e.visibleTokens : 0), 0);
			if (!this.force && !state.handoffs.some(h => h.cutoff > 0) && originalSize < memory.config.snapshotMin) request.cutoff = 0;
			if (this.force) request.preferLatestCutoff = true;
			const result = await memory.prepareCompaction(sessionId, request);
			if (!result.ok) fail(result.code, result.message);
			handoff = result.value;
			options.signal?.throwIfAborted();
			if (!this.live || this.store !== store || this.attachedSessionId !== sessionId) fail("REVISION_CONFLICT", "Host attachment changed during memory generation");
			if (queueRevision !== this.queueRevision) continue;
			if (this.session.agent.state.model.id !== model.id || this.session.agent.state.model.provider !== model.provider) fail("REVISION_CONFLICT", "Main model changed during preparation");
			if (digest({ systemPrompt: this.session.agent.state.systemPrompt, tools: this.session.agent.state.tools.map((t: any) => ({ name: t.name, description: t.description, parameters: t.parameters })) }) !== digest({ systemPrompt: context.systemPrompt, tools: (context.tools ?? []).map((t: any) => ({ name: t.name, description: t.description, parameters: t.parameters })) })) fail("REVISION_CONFLICT", "System instructions or tools changed during preparation");
			// No await between this check, refresh, durable CAS and request selection.
			const activated = memory.activateHandoff(sessionId, handoff.id, request.contextRevision);
			if (!activated.ok) fail(activated.code, activated.message);
			this.pending = activated.value.dispatchId; handoff = this.handoff(activated.value.handoffId); break;
		}
		this.force = false;
		update(store, sessionId, state => { const record = hostState(state).dispatches.find(d => d.id === this.pending)!; record.preparationMs = Date.now() - preparationStarted; });
		const outgoing = { ...context, messages: handoff.rendered.payload };
		const beforePayload = options.onPayload, dispatchId = this.pending;
		return this.observeResponse(model, outgoing, { ...options, maxTokens: request.outputReserve, maxRetries: 0, transport: "sse",
			onPayload: async (payload: any, selectedModel: any) => {
				const originalPayload = canonical(payload);
				const changed = beforePayload ? await beforePayload(payload, selectedModel) : undefined;
				if (canonical(payload) !== originalPayload || changed !== undefined && canonical(changed) !== originalPayload) fail("REVISION_CONFLICT", "A provider hook changed the validated request");
				if (!this.live || this.store !== store || this.attachedSessionId !== sessionId || this.sessionId !== sessionId) fail("REVISION_CONFLICT", "Host detached before provider send");
				textOnly(payload);
				const opaque = reasoningAccounting(store, sessionId).payload(payload, model);
				if (nativeTokenizer.count(canonical(opaque.counted)) + opaque.tokens + request.outputReserve + request.safetyMargin > model.contextWindow) fail("CONTEXT_BUDGET_EXCEEDED", "Final provider serialization exceeds the conservative context bound");
				const ref = saveJson(store, sessionId, payload);
				update(store, sessionId, state => {
					if (hostState(state).owner?.id !== this.owner) fail("REVISION_CONFLICT", "Dispatch ownership changed before provider send");
					const dispatch = hostState(state).dispatches.find(d => d.id === dispatchId);
					if (!dispatch || dispatch.state !== "accepted") fail("REVISION_CONFLICT", "Provider attempted to resend an already selected request");
					dispatch.state = "sent"; dispatch.providerPayloadRef = ref; dispatch.sentAt = Date.now();
				});
				return payload;
			},
		}, invoke, dispatchId);
	}
}
