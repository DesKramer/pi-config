export const REMOTE_PI_PROTOCOL_VERSION = "remote-pi.v1" as const;
export const REMOTE_PI_BRIDGE_VERSION = "0.1.0" as const;

export type ProtocolVersion = typeof REMOTE_PI_PROTOCOL_VERSION;

export const COMMAND_NAMES = [
	"session.create",
	"session.prompt",
	"session.steer",
	"session.followUp",
	"session.abort",
	"session.rename",
	"session.compact",
	"session.setModel",
	"session.setThinkingLevel",
	"session.fork",
	"session.clone",
	"session.switch",
	"session.getEntries",
	"session.getTree",
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];
export type AttachedCommandName = "session.prompt" | "session.steer" | "session.followUp" | "session.abort";

export const EVENT_NAMES = [
	"session.registered",
	"session.updated",
	"session.disconnected",
	"session.state",
	"message.started",
	"message.delta",
	"message.completed",
	"tool.started",
	"tool.updated",
	"tool.completed",
	"queue.updated",
	"agent.settled",
	"compaction.started",
	"compaction.completed",
	"retry.started",
	"retry.completed",
	"command.accepted",
	"command.completed",
	"error",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export type SessionState = "connected" | "idle" | "running" | "settling" | "retrying" | "compacting" | "disconnected" | "exited";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type Capability = {
	supported: boolean;
	reason?: "available" | "not_applicable" | "deferred" | "bridge_missing" | "state_dependent";
};

export type CapabilityMap = Record<CommandName, Capability>;

export type ModelSummary = {
	provider: string;
	modelId: string;
	displayName?: string;
	contextWindow?: number;
};

export type QueueSnapshot = {
	steeringCount: number;
	followUpCount: number;
	items?: Array<{
		queueItemId: string;
		kind: "steer" | "followUp";
		requestId?: string;
		commandId?: string;
		createdAt: string;
		messagePreview?: string;
	}>;
};

export type RetentionSnapshot = {
	liveEventsMaxCount: 10000;
	liveEventsMaxAgeSeconds: 86400;
	commandRecordsMaxAgeSeconds: 604800;
	eventReplayAvailableFrom?: string;
};

export type SessionSnapshot = {
	protocolVersion: ProtocolVersion;
	sessionId: string;
	sessionClass: "attached" | "managed";
	state: SessionState;
	name?: string | null;
	cwd: string;
	canonicalCwd?: string;
	model?: ModelSummary | null;
	thinkingLevel?: ThinkingLevel | null;
	piVersion?: string;
	bridgeVersion?: string;
	daemonVersion?: string;
	sessionFile?: string | null;
	createdAt: string;
	connectedAt?: string;
	lastActivityAt: string;
	exitedAt?: string | null;
	cursor: string;
	sequence: number;
	entryCursor?: string | null;
	capabilities: CapabilityMap;
	queue: QueueSnapshot;
	retention: RetentionSnapshot;
};

export type ErrorObject = {
	code:
		| "INVALID_REQUEST"
		| "MALFORMED_JSON"
		| "PROTOCOL_MISMATCH"
		| "UNSUPPORTED_COMMAND"
		| "UNSUPPORTED_SESSION_CLASS"
		| "SESSION_UNAVAILABLE"
		| "AGENT_BUSY"
		| "BRIDGE_DISCONNECTED"
		| "BRIDGE_PROTOCOL_ERROR"
		| "TIMEOUT"
		| "INTERNAL_ERROR";
	message: string;
	category: "invalid_request" | "unsupported" | "session_unavailable" | "agent_busy" | "bridge" | "timeout" | "internal";
	retryable: boolean;
	details?: Record<string, unknown>;
};

export type EventEnvelope = {
	protocolVersion: ProtocolVersion;
	eventId: string;
	type: EventName;
	sessionId: string;
	sessionClass: "attached" | "managed";
	sequence: number;
	cursor: string;
	entryCursor?: string | null;
	timestamp: string;
	causation?: {
		commandId?: string;
		requestId?: string;
		deviceId?: string;
		runId?: string;
	};
	payload: Record<string, unknown>;
};

export type BridgeEnvelope<T = Record<string, unknown>> = {
	protocolVersion: ProtocolVersion;
	type: string;
	bridgeId: string;
	sessionId?: string;
	bridgeSequence: number;
	timestamp: string;
	payload: T;
};

export type BridgeCommandPayload = {
	commandId: string;
	requestId: string;
	command: AttachedCommandName;
	payload: Record<string, unknown>;
};

export function remotePiError(
	code: ErrorObject["code"],
	message: string,
	category: ErrorObject["category"],
	retryable: boolean,
	details?: Record<string, unknown>,
): ErrorObject {
	return { code, message, category, retryable, ...(details ? { details } : {}) };
}

export function createAttachedCapabilityMap(available = true): CapabilityMap {
	return {
		"session.create": { supported: false, reason: "not_applicable" },
		"session.prompt": { supported: available, reason: available ? "available" : "bridge_missing" },
		"session.steer": { supported: available, reason: available ? "available" : "bridge_missing" },
		"session.followUp": { supported: available, reason: available ? "available" : "bridge_missing" },
		"session.abort": { supported: available, reason: available ? "available" : "bridge_missing" },
		"session.rename": { supported: false, reason: "deferred" },
		"session.compact": { supported: false, reason: "deferred" },
		"session.setModel": { supported: false, reason: "deferred" },
		"session.setThinkingLevel": { supported: false, reason: "deferred" },
		"session.fork": { supported: false, reason: "deferred" },
		"session.clone": { supported: false, reason: "deferred" },
		"session.switch": { supported: false, reason: "deferred" },
		"session.getEntries": { supported: false, reason: "deferred" },
		"session.getTree": { supported: false, reason: "deferred" },
	};
}

export function retentionDefaults(): RetentionSnapshot {
	return {
		liveEventsMaxCount: 10000,
		liveEventsMaxAgeSeconds: 86400,
		commandRecordsMaxAgeSeconds: 604800,
	};
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function isCommandName(value: unknown): value is CommandName {
	return typeof value === "string" && (COMMAND_NAMES as readonly string[]).includes(value);
}

export function isAttachedCommandName(value: unknown): value is AttachedCommandName {
	return value === "session.prompt" || value === "session.steer" || value === "session.followUp" || value === "session.abort";
}

export function isEventName(value: unknown): value is EventName {
	return typeof value === "string" && (EVENT_NAMES as readonly string[]).includes(value);
}
