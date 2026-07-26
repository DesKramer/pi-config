import type { AgentEndEvent, ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent, SessionCompactEvent, SessionInfoChangedEvent, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { accessSync, constants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect as netConnect } from "node:net";
import { encodeJsonlRecord, StrictLfJsonlParser } from "./jsonl.ts";
import {
	REMOTE_PI_BRIDGE_VERSION,
	REMOTE_PI_PROTOCOL_VERSION,
	createAttachedCapabilityMap,
	isAttachedCommandName,
	isEventName,
	nowIso,
	remotePiError,
	retentionDefaults,
	type AttachedCommandName,
	type BridgeCommandPayload,
	type BridgeEnvelope,
	type CapabilityMap,
	type ErrorObject,
	type EventName,
	type ModelSummary,
	type QueueSnapshot,
	type SessionSnapshot,
	type SessionState,
	type ThinkingLevel,
} from "./protocol.ts";

export const REMOTE_PI_STATUS_KEY = "remote-pi";
export const DEFAULT_BRIDGE_SOCKET_PATH = join(homedir(), "Library", "Application Support", "remote-pi", "bridge.sock");
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30000;

export type SocketLike = {
	write(data: string | Uint8Array): unknown;
	end(): unknown;
	destroy(): unknown;
	on(event: string, listener: (...args: any[]) => void): SocketLike;
	once(event: string, listener: (...args: any[]) => void): SocketLike;
	removeAllListeners?(event?: string): SocketLike;
	setEncoding?(encoding: BufferEncoding): void;
};

export type RemotePiBridgeOptions = {
	socketPath?: string;
	bridgeVersion?: string;
	connectFactory?: (socketPath: string) => SocketLike;
	heartbeatIntervalMs?: number;
	commandTimeoutMs?: number;
	reconnectBaseDelayMs?: number;
	reconnectMaxDelayMs?: number;
	reconnectJitterRatio?: number;
	random?: () => number;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
	now?: () => Date;
};

type Timer = ReturnType<typeof setTimeout>;
type BridgeStatus = "idle" | "connecting" | "connected" | "unavailable" | "shutdown";
type PendingCommand = { commandId: string; requestId: string; timer?: Timer };

type RuntimeContext = {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	createdAt: string;
	connectedAt?: string;
	lastActivityAt: string;
};

function defaultConnectFactory(socketPath: string): SocketLike {
	return netConnect(socketPath);
}

function unref(timer: Timer | undefined): void {
	const maybe = timer as { unref?: () => void } | undefined;
	maybe?.unref?.();
}

function modelSummary(model: ExtensionContext["model"]): ModelSummary | null {
	if (!model) return null;
	return {
		provider: String(model.provider),
		modelId: model.id,
		...(model.name ? { displayName: model.name } : {}),
		...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
	};
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel | null {
	return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
		? value
		: null;
}

function messagePreview(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const content = (message as { content?: unknown }).content;
	let text: string | undefined;
	if (typeof content === "string") text = content;
	if (Array.isArray(content)) {
		text = content
			.map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
			.join("");
	}
	if (!text) return undefined;
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function messageRole(message: unknown): string {
	return message && typeof message === "object" && typeof (message as { role?: unknown }).role === "string" ? (message as { role: string }).role : "custom";
}

function entryCursorFromContext(ctx: ExtensionContext): string | null {
	try {
		return ctx.sessionManager.getLeafId() ?? null;
	} catch {
		return null;
	}
}

function sessionFileFromContext(ctx: ExtensionContext): string | null {
	try {
		return ctx.sessionManager.getSessionFile() ?? null;
	} catch {
		return null;
	}
}

function piSessionIdFromContext(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

function canonicalCwd(cwd: string): string | undefined {
	try {
		const real = realpathSync(cwd);
		accessSync(real, constants.R_OK | constants.X_OK);
		return real;
	} catch {
		return undefined;
	}
}

function emptyQueueSnapshot(_ctx?: ExtensionContext): QueueSnapshot {
	// Pi's attached-extension API currently exposes only a coarse pending-message
	// boolean, not durable queue item identities or steer/follow-up splits. Do not
	// pretend full queue parity; report known-empty unless this bridge just queued
	// a remote steer/follow-up command and can describe that bridge-owned item.
	return {
		steeringCount: 0,
		followUpCount: 0,
		items: [],
	};
}

function commandPreview(payload: Record<string, unknown>): string | undefined {
	const message = payload.message;
	return typeof message === "string" ? (message.length > 80 ? `${message.slice(0, 77)}...` : message) : undefined;
}

function validatePromptPayload(payload: Record<string, unknown>): { ok: true; content: string | any[] } | { ok: false; error: ErrorObject } {
	const allowed = new Set(["message", "images"]);
	for (const key of Object.keys(payload)) {
		if (!allowed.has(key)) {
			return { ok: false, error: remotePiError("INVALID_REQUEST", `Unknown payload field: ${key}`, "invalid_request", false) };
		}
	}
	if (typeof payload.message !== "string" || payload.message.length === 0 || payload.message.length > 200_000) {
		return { ok: false, error: remotePiError("INVALID_REQUEST", "Prompt message must be a non-empty string no longer than 200000 characters.", "invalid_request", false) };
	}
	const images = payload.images;
	if (images === undefined) return { ok: true, content: payload.message };
	if (!Array.isArray(images) || images.length > 8) {
		return { ok: false, error: remotePiError("INVALID_REQUEST", "images must be an array with at most 8 items.", "invalid_request", false) };
	}
	for (const image of images) {
		if (!image || typeof image !== "object") return { ok: false, error: remotePiError("INVALID_REQUEST", "Each image must be an object.", "invalid_request", false) };
		const input = image as { type?: unknown; data?: unknown; mimeType?: unknown };
		if (input.type !== "image" || typeof input.data !== "string" || typeof input.mimeType !== "string") {
			return { ok: false, error: remotePiError("INVALID_REQUEST", "Images must use {type,data,mimeType}.", "invalid_request", false) };
		}
		if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(input.mimeType)) {
			return { ok: false, error: remotePiError("INVALID_REQUEST", `Unsupported image MIME type: ${input.mimeType}`, "invalid_request", false) };
		}
	}
	return { ok: true, content: [{ type: "text", text: payload.message }, ...images] };
}

function stateFromContext(ctx: ExtensionContext | undefined, fallback: SessionState): SessionState {
	if (!ctx) return fallback;
	return ctx.isIdle() ? "idle" : "running";
}

export class RemotePiBridgeClient {
	readonly bridgeId = randomUUID();
	private readonly socketPath: string;
	private readonly bridgeVersion: string;
	private readonly connectFactory: (socketPath: string) => SocketLike;
	private readonly setTimeoutFn: typeof setTimeout;
	private readonly clearTimeoutFn: typeof clearTimeout;
	private readonly now: () => Date;
	private readonly random: () => number;
	private readonly reconnectBaseDelayMs: number;
	private readonly reconnectMaxDelayMs: number;
	private readonly reconnectJitterRatio: number;
	private socket: SocketLike | undefined;
	private parser = new StrictLfJsonlParser();
	private bridgeSequence = 0;
	private heartbeatIntervalMs: number;
	private commandTimeoutMs: number;
	private heartbeatTimer: Timer | undefined;
	private reconnectTimer: Timer | undefined;
	private reconnectAttempt = 0;
	private registered = false;
	private shutdownRequested = false;
	private status: BridgeStatus = "idle";
	private runtime: RuntimeContext | undefined;
	private remoteSessionId: string | undefined;
	private state: SessionState = "connected";
	private lastSnapshotSequence = 0;
	private currentRunId: string | undefined;
	private readonly messageIds = new WeakMap<object, string>();
	private readonly pendingCommands = new Map<string, PendingCommand>();

	constructor(options: RemotePiBridgeOptions = {}) {
		this.socketPath = options.socketPath ?? DEFAULT_BRIDGE_SOCKET_PATH;
		this.bridgeVersion = options.bridgeVersion ?? REMOTE_PI_BRIDGE_VERSION;
		this.connectFactory = options.connectFactory ?? defaultConnectFactory;
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
		this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
		this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 500;
		this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 5000;
		this.reconnectJitterRatio = options.reconnectJitterRatio ?? 0.25;
		this.random = options.random ?? Math.random;
		this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
		this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
		this.now = options.now ?? (() => new Date());
	}

	start(pi: ExtensionAPI, ctx: ExtensionContext): void {
		const now = this.nowIso();
		this.runtime = { pi, ctx, createdAt: this.runtime?.createdAt ?? now, connectedAt: this.runtime?.connectedAt, lastActivityAt: now };
		this.state = stateFromContext(ctx, this.state === "disconnected" ? "connected" : this.state);
		this.updateStatus(ctx, this.status === "connected" ? "connected" : "connecting");
		if (!this.socket && !this.shutdownRequested) this.connect();
	}

	updateContext(ctx: ExtensionContext): void {
		if (this.runtime) {
			this.runtime.ctx = ctx;
			this.runtime.lastActivityAt = this.nowIso();
		}
	}

	shutdown(reason: SessionShutdownEvent["reason"] = "quit"): void {
		if (this.shutdownRequested) return;
		this.shutdownRequested = true;
		this.clearHeartbeat();
		this.clearReconnect();
		const previous = this.state;
		const terminal = reason === "quit" ? "exited" : "disconnected";
		this.sendBridgeEvent("session.disconnected", {
			previousState: previous,
			reason: "bridge_eof",
			lastSeenAt: this.nowIso(),
			reconnectable: reason !== "quit",
		});
		this.setState(terminal, `session_shutdown:${reason}`);
		this.failPending(remotePiError("BRIDGE_DISCONNECTED", "Remote Pi bridge shut down before the command completed.", "bridge", true));
		this.status = "shutdown";
		this.runtime?.ctx.ui.setStatus(REMOTE_PI_STATUS_KEY, undefined);
		try {
			this.socket?.end();
		} catch {
			this.socket?.destroy();
		}
		this.socket = undefined;
	}

	getStatus(): BridgeStatus {
		return this.status;
	}

	getSnapshot(): SessionSnapshot {
		return this.buildSnapshot();
	}

	sendEventFromHook(type: EventName, payload: Record<string, unknown>, extra: { entryCursor?: string | null; runId?: string } = {}): void {
		this.sendBridgeEvent(type, payload, extra);
	}

	onAgentStart(ctx: ExtensionContext): void {
		this.updateContext(ctx);
		this.currentRunId = randomUUID();
		this.setState("running", "agent_start", { runId: this.currentRunId });
	}

	onAgentEnd(_event: AgentEndEvent, ctx: ExtensionContext): void {
		this.updateContext(ctx);
		this.setState("settling", "agent_end", { runId: this.currentRunId });
	}

	onAgentSettled(ctx: ExtensionContext): void {
		this.updateContext(ctx);
		const runId = this.currentRunId;
		this.sendBridgeEvent("agent.settled", { runId, result: "settled", entryCursor: entryCursorFromContext(ctx), queue: emptyQueueSnapshot(ctx) }, { runId });
		this.setState("idle", "agent_settled", { runId });
		this.currentRunId = undefined;
	}

	onMessageStart(event: { message: unknown }, ctx: ExtensionContext): void {
		this.updateContext(ctx);
		const messageId = this.getMessageId(event.message);
		this.sendBridgeEvent("message.started", {
			messageId,
			role: messageRole(event.message),
			runId: this.currentRunId,
			entryCursor: entryCursorFromContext(ctx),
			contentPreview: messagePreview(event.message),
		}, { runId: this.currentRunId });
	}

	onMessageUpdate(event: { message: unknown; assistantMessageEvent: Record<string, unknown> }, ctx: ExtensionContext): void {
		this.updateContext(ctx);
		const delta = event.assistantMessageEvent as Record<string, unknown>;
		const payload: Record<string, unknown> = {
			messageId: this.getMessageId(event.message),
			runId: this.currentRunId,
			deltaType: delta.type,
		};
		for (const key of ["contentIndex", "delta", "partial", "toolCall", "reason"] as const) {
			if (key in delta) payload[key] = delta[key];
		}
		this.sendBridgeEvent("message.delta", payload, { runId: this.currentRunId });
	}

	onMessageEnd(event: { message: unknown }, ctx: ExtensionContext): void {
		this.updateContext(ctx);
		const message = event.message as Record<string, unknown>;
		this.sendBridgeEvent("message.completed", {
			messageId: this.getMessageId(event.message),
			role: messageRole(event.message),
			runId: this.currentRunId,
			message: event.message,
			entryCursor: entryCursorFromContext(ctx),
			finishReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
			isError: message.stopReason === "error" || message.stopReason === "aborted",
		}, { runId: this.currentRunId });
	}

	onToolStart(event: { toolCallId: string; toolName: string; args: unknown }, ctx: ExtensionContext): void {
		this.updateContext(ctx);
		this.sendBridgeEvent("tool.started", {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			runId: this.currentRunId,
			args: event.args,
			argsPreview: JSON.stringify(event.args)?.slice(0, 500),
		}, { runId: this.currentRunId });
	}

	onToolUpdate(event: { toolCallId: string; toolName: string; partialResult: unknown }, ctx: ExtensionContext): void {
		this.updateContext(ctx);
		this.sendBridgeEvent("tool.updated", { toolCallId: event.toolCallId, toolName: event.toolName, runId: this.currentRunId, partialResult: event.partialResult }, { runId: this.currentRunId });
	}

	onToolEnd(event: { toolCallId: string; toolName: string; result: unknown; isError: boolean }, ctx: ExtensionContext): void {
		this.updateContext(ctx);
		this.sendBridgeEvent("tool.completed", { toolCallId: event.toolCallId, toolName: event.toolName, runId: this.currentRunId, result: event.result, isError: event.isError }, { runId: this.currentRunId });
	}

	onModelSelect(_event: unknown, ctx: ExtensionContext): void {
		this.updateContext(ctx);
		this.sendBridgeEvent("session.updated", { snapshot: this.buildSnapshot(), changed: ["model"] });
	}

	onThinkingLevelSelect(_event: unknown, ctx: ExtensionContext): void {
		this.updateContext(ctx);
		this.sendBridgeEvent("session.updated", { snapshot: this.buildSnapshot(), changed: ["thinkingLevel"] });
	}

	onSessionInfoChanged(_event: SessionInfoChangedEvent, ctx: ExtensionContext): void {
		this.updateContext(ctx);
		this.sendBridgeEvent("session.updated", { snapshot: this.buildSnapshot(), changed: ["name"] });
	}

	onSessionBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): void {
		this.updateContext(ctx);
		this.sendBridgeEvent("compaction.started", { reason: event.reason, customInstructionsPresent: Boolean(event.customInstructions) });
		this.setState("compacting", `compaction:${event.reason}`, { runId: this.currentRunId });
	}

	onSessionCompact(event: SessionCompactEvent, ctx: ExtensionContext): void {
		this.updateContext(ctx);
		this.sendBridgeEvent("compaction.completed", {
			reason: event.reason,
			result: {
				summary: event.compactionEntry.summary,
				firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
				tokensBefore: event.compactionEntry.tokensBefore,
				details: event.compactionEntry.details,
			},
			aborted: false,
			willRetry: event.willRetry,
			entryCursor: entryCursorFromContext(ctx),
		});
		this.setState(stateFromContext(ctx, "idle"), "compaction_completed", { runId: this.currentRunId });
	}

	private connect(): void {
		if (this.shutdownRequested) return;
		this.clearReconnect();
		this.registered = false;
		this.parser = new StrictLfJsonlParser();
		this.updateStatus(this.runtime?.ctx, "connecting");
		let socket: SocketLike;
		try {
			socket = this.connectFactory(this.socketPath);
		} catch (error) {
			this.handleSocketUnavailable(error);
			return;
		}
		this.socket = socket;
		socket.setEncoding?.("utf8");
		socket.once("connect", () => this.handleConnect());
		socket.on("data", (chunk: Buffer | string) => this.handleData(chunk));
		socket.once("error", (error: Error) => this.handleSocketUnavailable(error));
		socket.once("close", () => this.handleClose());
	}

	private handleConnect(): void {
		if (this.shutdownRequested) return;
		this.reconnectAttempt = 0;
		this.updateStatus(this.runtime?.ctx, "connected");
		this.sendRegister();
	}

	private handleSocketUnavailable(_error: unknown): void {
		if (this.shutdownRequested) return;
		this.updateStatus(this.runtime?.ctx, "unavailable");
		this.scheduleReconnect();
	}

	private handleClose(): void {
		if (this.shutdownRequested) return;
		this.socket = undefined;
		this.clearHeartbeat();
		this.registered = false;
		this.failPending(remotePiError("BRIDGE_DISCONNECTED", "Remote Pi bridge disconnected before the command completed.", "bridge", true));
		if (this.state !== "disconnected") {
			const previous = this.state;
			this.state = "disconnected";
			this.sendBridgeEvent("session.disconnected", { previousState: previous, reason: "bridge_eof", lastSeenAt: this.nowIso(), reconnectable: true });
		}
		this.updateStatus(this.runtime?.ctx, "unavailable");
		this.scheduleReconnect();
	}

	private handleData(chunk: Buffer | string): void {
		for (const result of this.parser.push(chunk)) {
			if (!result.ok) {
				this.sendBridgeEvent("error", { error: remotePiError("MALFORMED_JSON", result.error.message, "invalid_request", false), scope: "bridge" });
				this.socket?.destroy();
				return;
			}
			this.handleRecord(result.value);
		}
	}

	private handleRecord(value: unknown): void {
		if (!value || typeof value !== "object") return;
		const envelope = value as BridgeEnvelope<any>;
		if (envelope.protocolVersion !== REMOTE_PI_PROTOCOL_VERSION) {
			this.sendBridgeEvent("error", { error: remotePiError("PROTOCOL_MISMATCH", "Unsupported Remote Pi protocol version.", "invalid_request", false), scope: "bridge" });
			this.socket?.destroy();
			return;
		}

		switch (envelope.type) {
			case "bridge.registered":
				this.handleRegistered(envelope);
				break;
			case "bridge.heartbeatAck":
				break;
			case "bridge.snapshot.request":
				this.handleSnapshotRequest(envelope);
				break;
			case "bridge.command":
				void this.handleCommand(envelope as BridgeEnvelope<BridgeCommandPayload>);
				break;
			default:
				this.sendBridgeEvent("error", { error: remotePiError("BRIDGE_PROTOCOL_ERROR", `Unsupported bridge record type: ${String(envelope.type)}`, "bridge", false), scope: "bridge" });
		}
	}

	private handleRegistered(envelope: BridgeEnvelope<{ sessionId: string; heartbeatIntervalMs?: number; commandTimeoutMs?: number }>): void {
		this.registered = true;
		this.remoteSessionId = envelope.payload.sessionId;
		if (typeof envelope.payload.heartbeatIntervalMs === "number" && envelope.payload.heartbeatIntervalMs > 0) this.heartbeatIntervalMs = envelope.payload.heartbeatIntervalMs;
		if (typeof envelope.payload.commandTimeoutMs === "number" && envelope.payload.commandTimeoutMs > 0) this.commandTimeoutMs = envelope.payload.commandTimeoutMs;
		this.runtime!.connectedAt = this.nowIso();
		this.state = stateFromContext(this.runtime?.ctx, "connected");
		this.startHeartbeat();
		this.updateStatus(this.runtime?.ctx, "connected");
	}

	private handleSnapshotRequest(envelope: BridgeEnvelope<{ requestId: string }>): void {
		this.writeEnvelope("bridge.snapshot", {
			requestId: envelope.payload.requestId,
			snapshot: this.bridgeSnapshotPayload(),
		});
	}

	private async handleCommand(envelope: BridgeEnvelope<BridgeCommandPayload>): Promise<void> {
		const command = envelope.payload.command;
		const commandId = envelope.payload.commandId;
		const requestId = envelope.payload.requestId;
		if (!isAttachedCommandName(command)) {
			this.writeCommandResult(commandId, requestId, false, undefined, remotePiError("UNSUPPORTED_COMMAND", `Unsupported attached bridge command: ${String(command)}`, "unsupported", false));
			return;
		}
		const pending: PendingCommand = { commandId, requestId };
		pending.timer = this.setTimeoutFn(() => {
			this.pendingCommands.delete(commandId);
			this.writeCommandResult(commandId, requestId, false, undefined, remotePiError("TIMEOUT", "Bridge command timed out.", "timeout", true));
		}, this.commandTimeoutMs);
		unref(pending.timer);
		this.pendingCommands.set(commandId, pending);
		try {
			const result = this.executeCommand(command, envelope.payload.payload, commandId, requestId);
			this.finishPending(commandId);
			this.writeCommandResult(commandId, requestId, true, result);
		} catch (error) {
			this.finishPending(commandId);
			this.writeCommandResult(commandId, requestId, false, undefined, error instanceof RemotePiCommandError ? error.error : remotePiError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error), "internal", true));
		}
	}

	private executeCommand(command: AttachedCommandName, payload: Record<string, unknown>, commandId: string, requestId: string): unknown {
		const runtime = this.runtime;
		if (!runtime) throw new RemotePiCommandError(remotePiError("SESSION_UNAVAILABLE", "Pi extension runtime is not ready.", "session_unavailable", true));
		const { pi, ctx } = runtime;
		this.remoteCommandVisible(command, payload);
		if (command === "session.abort") {
			if (Object.keys(payload).length > 0) throw new RemotePiCommandError(remotePiError("INVALID_REQUEST", "session.abort does not accept a payload.", "invalid_request", false));
			const previousState = this.state;
			if (ctx.isIdle()) return { aborted: false, previousState };
			ctx.abort();
			this.setState("idle", "remote_abort", { commandId, requestId, runId: this.currentRunId });
			return { aborted: true, previousState };
		}

		const validation = validatePromptPayload(payload);
		if (!validation.ok) throw new RemotePiCommandError(validation.error);
		const active = !ctx.isIdle();
		if (command === "session.prompt") {
			if (active) throw new RemotePiCommandError(remotePiError("AGENT_BUSY", "session.prompt requires the attached Pi session to be idle; use session.steer or session.followUp while active.", "agent_busy", true));
			pi.sendUserMessage(validation.content as any);
			this.setState("running", "remote_prompt", { commandId, requestId, runId: this.currentRunId });
			return { piAcceptance: "accepted", finality: "acceptance_only" };
		}
		if (!active) throw new RemotePiCommandError(remotePiError("AGENT_BUSY", `${command} requires an active attached Pi run.`, "agent_busy", true));
		const deliverAs = command === "session.steer" ? "steer" : "followUp";
		pi.sendUserMessage(validation.content as any, { deliverAs });
		const queue = emptyQueueSnapshot(ctx);
		queue.items = [{ queueItemId: randomUUID(), kind: deliverAs === "steer" ? "steer" : "followUp", requestId, commandId, createdAt: this.nowIso(), messagePreview: commandPreview(payload) }];
		if (deliverAs === "steer") queue.steeringCount = Math.max(1, queue.steeringCount);
		else queue.followUpCount = Math.max(1, queue.followUpCount);
		this.sendBridgeEvent("queue.updated", queue, { commandId, requestId, runId: this.currentRunId });
		return { queued: true, queue };
	}

	private remoteCommandVisible(command: AttachedCommandName, payload: Record<string, unknown>): void {
		const ctx = this.runtime?.ctx;
		if (!ctx?.hasUI) return;
		const detail = commandPreview(payload);
		ctx.ui.setStatus(REMOTE_PI_STATUS_KEY, ctx.ui.theme.fg("accent", `remote-pi: ${command.replace("session.", "")}`));
		ctx.ui.notify(`Remote Pi ${command.replace("session.", "")} received${detail ? `: ${detail}` : ""}`, "info");
	}

	private sendRegister(): void {
		const runtime = this.runtime;
		if (!runtime) return;
		const ctx = runtime.ctx;
		const payload = {
			...(this.remoteSessionId ? { sessionId: this.remoteSessionId } : {}),
			piSessionId: piSessionIdFromContext(ctx),
			sessionFile: sessionFileFromContext(ctx),
			cwd: ctx.cwd,
			name: runtime.pi.getSessionName?.() ?? null,
			model: modelSummary(ctx.model),
			thinkingLevel: normalizeThinkingLevel(runtime.pi.getThinkingLevel?.()),
			piVersion: PI_VERSION,
			bridgeVersion: this.bridgeVersion,
			pid: process.pid,
			state: stateFromContext(ctx, this.state),
			entryCursor: entryCursorFromContext(ctx),
			capabilities: pickAttachedCapabilities(createAttachedCapabilityMap(true)),
		};
		this.writeEnvelope("bridge.register", payload);
	}

	private startHeartbeat(): void {
		this.clearHeartbeat();
		const tick = () => {
			if (this.shutdownRequested || !this.socket || !this.registered) return;
			const ctx = this.runtime?.ctx;
			this.writeEnvelope("bridge.heartbeat", {
				state: stateFromContext(ctx, this.state),
				lastActivityAt: this.runtime?.lastActivityAt ?? this.nowIso(),
				entryCursor: ctx ? entryCursorFromContext(ctx) : null,
			});
			this.heartbeatTimer = this.setTimeoutFn(tick, this.heartbeatIntervalMs);
			unref(this.heartbeatTimer);
		};
		this.heartbeatTimer = this.setTimeoutFn(tick, this.heartbeatIntervalMs);
		unref(this.heartbeatTimer);
	}

	private clearHeartbeat(): void {
		if (this.heartbeatTimer) this.clearTimeoutFn(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
	}

	private scheduleReconnect(): void {
		if (this.shutdownRequested || this.reconnectTimer) return;
		const attempt = this.reconnectAttempt++;
		const base = Math.min(this.reconnectBaseDelayMs * 2 ** attempt, this.reconnectMaxDelayMs);
		const jitter = base * this.reconnectJitterRatio * this.random();
		this.reconnectTimer = this.setTimeoutFn(() => {
			this.reconnectTimer = undefined;
			this.connect();
		}, base + jitter);
		unref(this.reconnectTimer);
	}

	private clearReconnect(): void {
		if (this.reconnectTimer) this.clearTimeoutFn(this.reconnectTimer);
		this.reconnectTimer = undefined;
	}

	private setState(state: SessionState, reason: string, causation?: { commandId?: string; requestId?: string; runId?: string }): void {
		if (this.state === state) return;
		const previousState = this.state;
		this.state = state;
		this.sendBridgeEvent("session.state", { previousState, state, reason, snapshot: this.buildSnapshot() }, causation);
	}

	private sendBridgeEvent(type: EventName, payload: Record<string, unknown>, causation: { commandId?: string; requestId?: string; runId?: string } = {}): void {
		if (!isEventName(type)) return;
		const ctx = this.runtime?.ctx;
		this.writeEnvelope("bridge.event", {
			event: {
				type,
				entryCursor: ctx ? entryCursorFromContext(ctx) : null,
				...(Object.values(causation).some(Boolean) ? { causation } : {}),
				payload,
			},
		});
	}

	private writeCommandResult(commandId: string, requestId: string, success: boolean, result?: unknown, error?: ErrorObject): void {
		this.writeEnvelope("bridge.command.result", { commandId, requestId, success, ...(success ? { result } : { error }) });
	}

	private writeEnvelope<T>(type: string, payload: T): void {
		if (!this.socket || this.shutdownRequested && type !== "bridge.event") return;
		const envelope: BridgeEnvelope<T> = {
			protocolVersion: REMOTE_PI_PROTOCOL_VERSION,
			type,
			bridgeId: this.bridgeId,
			...(this.remoteSessionId ? { sessionId: this.remoteSessionId } : {}),
			bridgeSequence: ++this.bridgeSequence,
			timestamp: this.nowIso(),
			payload,
		};
		try {
			this.socket.write(encodeJsonlRecord(envelope));
		} catch {
			this.handleClose();
		}
	}

	private buildSnapshot(): SessionSnapshot {
		const ctx = this.runtime?.ctx;
		const now = this.nowIso();
		const sessionId = this.remoteSessionId ?? piSessionIdFromContext(ctx as ExtensionContext) ?? this.bridgeId;
		return {
			protocolVersion: REMOTE_PI_PROTOCOL_VERSION,
			sessionId,
			sessionClass: "attached",
			state: this.state,
			name: this.runtime?.pi.getSessionName?.() ?? null,
			cwd: ctx?.cwd ?? process.cwd(),
			...(ctx?.cwd ? { canonicalCwd: canonicalCwd(ctx.cwd) } : {}),
			model: modelSummary(ctx?.model),
			thinkingLevel: normalizeThinkingLevel(this.runtime?.pi.getThinkingLevel?.()),
			piVersion: PI_VERSION,
			bridgeVersion: this.bridgeVersion,
			sessionFile: ctx ? sessionFileFromContext(ctx) : null,
			createdAt: this.runtime?.createdAt ?? now,
			connectedAt: this.runtime?.connectedAt,
			lastActivityAt: this.runtime?.lastActivityAt ?? now,
			cursor: `bridge-local-${this.lastSnapshotSequence}`,
			sequence: this.lastSnapshotSequence,
			entryCursor: ctx ? entryCursorFromContext(ctx) : null,
			capabilities: createAttachedCapabilityMap(this.status === "connected" || this.status === "connecting"),
			queue: emptyQueueSnapshot(ctx),
			retention: retentionDefaults(),
		};
	}

	private bridgeSnapshotPayload(): Omit<SessionSnapshot, "protocolVersion" | "cursor" | "sequence" | "retention"> {
		this.lastSnapshotSequence += 1;
		const snapshot = this.buildSnapshot();
		const { protocolVersion: _protocolVersion, cursor: _cursor, sequence: _sequence, retention: _retention, ...bridgeSnapshot } = snapshot;
		return bridgeSnapshot;
	}

	private getMessageId(message: unknown): string {
		if (message && typeof message === "object") {
			const existing = this.messageIds.get(message);
			if (existing) return existing;
			const id = randomUUID();
			this.messageIds.set(message, id);
			return id;
		}
		return randomUUID();
	}

	private finishPending(commandId: string): void {
		const pending = this.pendingCommands.get(commandId);
		if (pending?.timer) this.clearTimeoutFn(pending.timer);
		this.pendingCommands.delete(commandId);
	}

	private failPending(error: ErrorObject): void {
		for (const pending of this.pendingCommands.values()) {
			if (pending.timer) this.clearTimeoutFn(pending.timer);
			this.writeCommandResult(pending.commandId, pending.requestId, false, undefined, error);
		}
		this.pendingCommands.clear();
	}

	private updateStatus(ctx: ExtensionContext | undefined, status: BridgeStatus): void {
		this.status = status;
		if (!ctx?.hasUI) return;
		const color = status === "connected" ? "success" : status === "connecting" ? "dim" : status === "shutdown" ? "dim" : "warning";
		const text = status === "connected" ? "remote-pi: connected" : status === "connecting" ? "remote-pi: connecting" : status === "shutdown" ? "remote-pi: off" : "remote-pi: unavailable";
		ctx.ui.setStatus(REMOTE_PI_STATUS_KEY, ctx.ui.theme.fg(color as any, text));
	}

	private nowIso(): string {
		return this.now().toISOString();
	}
}

class RemotePiCommandError extends Error {
	readonly error: ErrorObject;
	constructor(error: ErrorObject) {
		super(error.message);
		this.error = error;
	}
}

function pickAttachedCapabilities(capabilities: CapabilityMap): Pick<CapabilityMap, "session.prompt" | "session.steer" | "session.followUp" | "session.abort"> {
	return {
		"session.prompt": capabilities["session.prompt"],
		"session.steer": capabilities["session.steer"],
		"session.followUp": capabilities["session.followUp"],
		"session.abort": capabilities["session.abort"],
	};
}

export function createRemotePiExtension(options: RemotePiBridgeOptions = {}) {
	return (pi: ExtensionAPI): void => {
		const bridge = new RemotePiBridgeClient(options);

		pi.registerCommand("remote-pi-status", {
			description: "Show Remote Pi attached-session bridge status and capabilities",
			handler: async (_args, ctx) => {
				const snapshot = bridge.getSnapshot();
				const supported = Object.entries(snapshot.capabilities)
					.filter(([, cap]) => cap.supported)
					.map(([name]) => name)
					.join(", ");
				const unsupported = Object.entries(snapshot.capabilities)
					.filter(([, cap]) => !cap.supported)
					.map(([name, cap]) => `${name}:${cap.reason ?? "unsupported"}`)
					.join(", ");
				ctx.ui.notify(
					`Remote Pi bridge ${bridge.getStatus()}\nSocket: ${DEFAULT_BRIDGE_SOCKET_PATH}\nSession: ${snapshot.sessionId}\nSupported: ${supported || "none"}\nUnsupported: ${unsupported}\nBridge approval dialogs: unsupported by remote-pi.v1; no remote approval wait is performed.`,
					bridge.getStatus() === "connected" ? "info" : "warning",
				);
			},
		});

		pi.on("session_start", (_event, ctx) => bridge.start(pi, ctx));
		pi.on("session_info_changed", (event, ctx) => bridge.onSessionInfoChanged(event, ctx));
		pi.on("agent_start", (_event, ctx) => bridge.onAgentStart(ctx));
		pi.on("agent_end", (event, ctx) => bridge.onAgentEnd(event, ctx));
		pi.on("agent_settled", (_event, ctx) => bridge.onAgentSettled(ctx));
		pi.on("message_start", (event, ctx) => bridge.onMessageStart(event, ctx));
		pi.on("message_update", (event, ctx) => bridge.onMessageUpdate(event, ctx));
		pi.on("message_end", (event, ctx) => bridge.onMessageEnd(event, ctx));
		pi.on("tool_execution_start", (event, ctx) => bridge.onToolStart(event, ctx));
		pi.on("tool_execution_update", (event, ctx) => bridge.onToolUpdate(event, ctx));
		pi.on("tool_execution_end", (event, ctx) => bridge.onToolEnd(event, ctx));
		pi.on("model_select", (event, ctx) => bridge.onModelSelect(event, ctx));
		pi.on("thinking_level_select", (event, ctx) => bridge.onThinkingLevelSelect(event, ctx));
		pi.on("session_before_compact", (event, ctx) => bridge.onSessionBeforeCompact(event, ctx));
		pi.on("session_compact", (event, ctx) => bridge.onSessionCompact(event, ctx));
		pi.on("session_shutdown", (event) => bridge.shutdown(event.reason));
	};
}

export default createRemotePiExtension();
