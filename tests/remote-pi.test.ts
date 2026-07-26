import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { encodeJsonlRecord, StrictLfJsonlParser } from "../extensions/remote-pi/jsonl.ts";
import { REMOTE_PI_PROTOCOL_VERSION, createAttachedCapabilityMap } from "../extensions/remote-pi/protocol.ts";
import { RemotePiBridgeClient, createRemotePiExtension, type SocketLike } from "../extensions/remote-pi/index.ts";

class FakeSocket extends EventEmitter implements SocketLike {
	writes: string[] = [];
	ended = false;
	destroyed = false;
	write(data: string | Uint8Array): boolean {
		this.writes.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
		return true;
	}
	end(): this {
		this.ended = true;
		this.emit("close");
		return this;
	}
	destroy(): this {
		this.destroyed = true;
		this.emit("close");
		return this;
	}
	setEncoding(_encoding: BufferEncoding): this {
		return this;
	}
}

type FakeRegistration = {
	events: Map<string, (event: any, ctx: any) => unknown>;
	commands: Map<string, { handler: (args: string, ctx: any) => unknown }>;
};

function registerExtension(options: ConstructorParameters<typeof RemotePiBridgeClient>[0] = {}): FakeRegistration {
	const events = new Map<string, (event: any, ctx: any) => unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
	createRemotePiExtension(options)({
		on: (name: string, handler: (event: any, ctx: any) => unknown) => events.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getSessionName: () => "Test session",
		getThinkingLevel: () => "medium",
		sendUserMessage: () => {},
	} as any);
	return { events, commands };
}

function fakeCtx(overrides: Partial<any> = {}) {
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const aborts: string[] = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/tmp",
		model: { provider: "openai", id: "gpt-5", name: "GPT-5", contextWindow: 200000 },
		ui: {
			theme: { fg: (color: string, text: string) => `[${color}]${text}` },
			setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
		sessionManager: {
			getSessionId: () => "pi-session-test",
			getSessionFile: () => "/tmp/pi-session.jsonl",
			getLeafId: () => "leaf-1",
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => aborts.push("abort"),
		...overrides,
	};
	return { ctx, statuses, notifications, aborts };
}

function fakePi(overrides: Partial<any> = {}) {
	const sent: Array<{ content: unknown; options?: unknown }> = [];
	return {
		pi: {
			getSessionName: () => "Test session",
			getThinkingLevel: () => "medium",
			sendUserMessage: (content: unknown, options?: unknown) => sent.push({ content, options }),
			...overrides,
		},
		sent,
	};
}

function records(socket: FakeSocket): any[] {
	return socket.writes
		.join("")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function sendRegistered(socket: FakeSocket, sessionId = "remote-session-1", heartbeatIntervalMs = 5000, commandTimeoutMs = 30000) {
	socket.emit(
		"data",
		encodeJsonlRecord({
			protocolVersion: REMOTE_PI_PROTOCOL_VERSION,
			type: "bridge.registered",
			bridgeId: "daemon",
			sessionId,
			bridgeSequence: 1,
			timestamp: new Date().toISOString(),
			payload: { sessionId, heartbeatIntervalMs, commandTimeoutMs, acceptedProtocolVersion: REMOTE_PI_PROTOCOL_VERSION },
		}),
	);
}

function sendCommand(socket: FakeSocket, command: string, payload: Record<string, unknown> = {}, commandId = "cmd-1", requestId = "req-1") {
	socket.emit(
		"data",
		encodeJsonlRecord({
			protocolVersion: REMOTE_PI_PROTOCOL_VERSION,
			type: "bridge.command",
			bridgeId: "daemon",
			sessionId: "remote-session-1",
			bridgeSequence: 2,
			timestamp: new Date().toISOString(),
			payload: { commandId, requestId, command, payload },
		}),
	);
}

function wait(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("strict LF JSONL encodes one LF record and parses bridge fixtures without generic line readers", () => {
	const encoded = encodeJsonlRecord({ text: "escaped\nnewline", separator: "line separator" });
	assert.equal(encoded.endsWith("\n"), true);
	assert.equal(encoded.includes("\r\n"), false);
	assert.equal(encoded.split("\n").length, 2, "only framing LF should be raw");

	const parser = new StrictLfJsonlParser();
	const parsed = parser.push(encoded);
	assert.equal(parsed.length, 1);
	assert.deepEqual(parsed[0], { ok: true, value: { text: "escaped\nnewline", separator: "line separator" } });

	const crlf = new StrictLfJsonlParser().push('{"ok":true}\r\n');
	assert.equal(crlf[0]?.ok, false, "CRLF is rejected for bridge JSONL");

	for (const name of ["register.jsonl", "heartbeat.jsonl", "snapshot.jsonl", "command-result.jsonl", "event.jsonl"]) {
		const fixture = readFileSync(`/Users/deskramer/Documents/Code/remote-pi/docs/fixtures/protocol/v1/bridge/${name}`, "utf8");
		const fixtureParser = new StrictLfJsonlParser();
		const results = fixtureParser.push(fixture);
		assert.ok(results.length > 0, name);
		for (const result of results) {
			assert.equal(result.ok, true, `${name}: ${(result as any).error?.message}`);
			if (result.ok) assert.equal((result.value as any).protocolVersion, REMOTE_PI_PROTOCOL_VERSION);
		}
	}
});

test("session_start registers an attached TUI session with snapshot capabilities and heartbeats", async () => {
	const socket = new FakeSocket();
	const { pi } = fakePi();
	const { ctx, statuses } = fakeCtx();
	const bridge = new RemotePiBridgeClient({ connectFactory: () => socket, heartbeatIntervalMs: 10, random: () => 0 });
	bridge.start(pi as any, ctx as any);
	socket.emit("connect");
	let all = records(socket);
	assert.equal(all[0].type, "bridge.register");
	assert.equal(all[0].protocolVersion, REMOTE_PI_PROTOCOL_VERSION);
	assert.equal(all[0].payload.cwd, "/tmp");
	assert.deepEqual(all[0].payload.capabilities, {
		"session.prompt": { supported: true, reason: "available" },
		"session.steer": { supported: true, reason: "available" },
		"session.followUp": { supported: true, reason: "available" },
		"session.abort": { supported: true, reason: "available" },
	});

	sendRegistered(socket, "remote-session-1", 10, 1000);
	socket.emit(
		"data",
		encodeJsonlRecord({
			protocolVersion: REMOTE_PI_PROTOCOL_VERSION,
			type: "bridge.snapshot.request",
			bridgeId: "daemon",
			sessionId: "remote-session-1",
			bridgeSequence: 3,
			timestamp: new Date().toISOString(),
			payload: { requestId: "snap-1" },
		}),
	);
	await wait(15);
	all = records(socket);
	const snapshot = all.find((record) => record.type === "bridge.snapshot");
	assert.ok(snapshot);
	assert.equal(snapshot.payload.snapshot.sessionId, "remote-session-1");
	assert.equal(snapshot.payload.snapshot.protocolVersion, undefined);
	assert.equal(snapshot.payload.snapshot.cursor, undefined);
	assert.deepEqual(snapshot.payload.snapshot.capabilities, createAttachedCapabilityMap(true));
	assert.ok(all.some((record) => record.type === "bridge.heartbeat"));
	assert.ok(statuses.some((status) => status.text === "[success]remote-pi: connected"));
});

test("attached prompt, steer, followUp, and abort commands use Pi APIs and return command results", async () => {
	const socket = new FakeSocket();
	const { pi, sent } = fakePi();
	let idle = true;
	const { ctx, notifications, aborts } = fakeCtx({ isIdle: () => idle });
	const bridge = new RemotePiBridgeClient({ connectFactory: () => socket, commandTimeoutMs: 1000 });
	bridge.start(pi as any, ctx as any);
	socket.emit("connect");
	sendRegistered(socket);

	sendCommand(socket, "session.prompt", { message: "hello" }, "cmd-prompt", "req-prompt");
	await wait();
	assert.deepEqual(sent.at(-1), { content: "hello", options: undefined });
	let result = records(socket).find((record) => record.type === "bridge.command.result" && record.payload.commandId === "cmd-prompt");
	assert.equal(result.payload.success, true);
	assert.deepEqual(result.payload.result, { piAcceptance: "accepted", finality: "acceptance_only" });

	idle = false;
	sendCommand(socket, "session.steer", { message: "steer me" }, "cmd-steer", "req-steer");
	sendCommand(socket, "session.followUp", { message: "later" }, "cmd-follow", "req-follow");
	await wait();
	assert.deepEqual(sent.at(-2), { content: "steer me", options: { deliverAs: "steer" } });
	assert.deepEqual(sent.at(-1), { content: "later", options: { deliverAs: "followUp" } });
	assert.ok(records(socket).some((record) => record.type === "bridge.event" && record.payload.event.type === "queue.updated"));

	sendCommand(socket, "session.abort", {}, "cmd-abort", "req-abort");
	await wait();
	assert.deepEqual(aborts, ["abort"]);
	result = records(socket).find((record) => record.type === "bridge.command.result" && record.payload.commandId === "cmd-abort");
	assert.equal(result.payload.success, true);
	assert.equal(result.payload.result.aborted, true);
	assert.ok(notifications.some((notification) => /Remote Pi prompt received/.test(notification.message)));
});

test("command validation returns explicit unsupported/session-state errors instead of pretending parity", async () => {
	const socket = new FakeSocket();
	const { pi } = fakePi();
	const { ctx } = fakeCtx({ isIdle: () => true });
	const bridge = new RemotePiBridgeClient({ connectFactory: () => socket, commandTimeoutMs: 1000 });
	bridge.start(pi as any, ctx as any);
	socket.emit("connect");
	sendRegistered(socket);

	sendCommand(socket, "session.rename", { name: "nope" }, "cmd-rename", "req-rename");
	sendCommand(socket, "session.steer", { message: "too soon" }, "cmd-busy", "req-busy");
	await wait();
	const all = records(socket).filter((record) => record.type === "bridge.command.result");
	assert.equal(all.find((record) => record.payload.commandId === "cmd-rename").payload.error.code, "UNSUPPORTED_COMMAND");
	assert.equal(all.find((record) => record.payload.commandId === "cmd-busy").payload.error.code, "AGENT_BUSY");
});

test("available Pi lifecycle hooks are normalized as bridge events with synthesized run and message IDs", () => {
	const socket = new FakeSocket();
	const { pi } = fakePi();
	const { ctx } = fakeCtx({ isIdle: () => false });
	const bridge = new RemotePiBridgeClient({ connectFactory: () => socket });
	bridge.start(pi as any, ctx as any);
	socket.emit("connect");
	sendRegistered(socket);

	bridge.onAgentStart(ctx as any);
	const assistant = { role: "assistant", content: [{ type: "text", text: "Hi" }], stopReason: "stop", timestamp: Date.now() };
	bridge.onMessageStart({ type: "message_start", message: assistant } as any, ctx as any);
	bridge.onMessageUpdate({ type: "message_update", message: assistant, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi", partial: assistant } } as any, ctx as any);
	bridge.onToolStart({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "pwd" } } as any, ctx as any);
	bridge.onToolUpdate({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "/tmp" }] } } as any, ctx as any);
	bridge.onToolEnd({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: { content: [{ type: "text", text: "/tmp" }] }, isError: false } as any, ctx as any);
	bridge.onMessageEnd({ type: "message_end", message: assistant } as any, ctx as any);
	bridge.onAgentEnd({ type: "agent_end", messages: [assistant] } as any, ctx as any);
	bridge.onAgentSettled({ ...ctx, isIdle: () => true } as any);
	bridge.onModelSelect({ type: "model_select", model: ctx.model, previousModel: undefined, source: "set" } as any, ctx as any);
	bridge.onThinkingLevelSelect({ type: "thinking_level_select", level: "high", previousLevel: "medium" } as any, ctx as any);
	bridge.onSessionBeforeCompact({ type: "session_before_compact", reason: "manual", willRetry: false, branchEntries: [], preparation: {}, signal: new AbortController().signal } as any, ctx as any);
	bridge.onSessionCompact({ type: "session_compact", reason: "manual", willRetry: false, fromExtension: false, compactionEntry: { summary: "s", firstKeptEntryId: "leaf-1", tokensBefore: 100 } } as any, { ...ctx, isIdle: () => true } as any);

	const events = records(socket).filter((record) => record.type === "bridge.event").map((record) => record.payload.event);
	for (const type of [
		"session.state",
		"message.started",
		"message.delta",
		"tool.started",
		"tool.updated",
		"tool.completed",
		"message.completed",
		"agent.settled",
		"session.updated",
		"compaction.started",
		"compaction.completed",
	]) {
		assert.ok(events.some((event) => event.type === type), type);
	}
	const started = events.find((event) => event.type === "message.started");
	const delta = events.find((event) => event.type === "message.delta");
	assert.match(started.payload.messageId, /^[0-9a-f-]{36}$/);
	assert.equal(delta.payload.messageId, started.payload.messageId);
	assert.match(started.payload.runId, /^[0-9a-f-]{36}$/);
});

test("extension registration exposes local status command and fails open when daemon is unavailable", async () => {
	const { events, commands } = registerExtension({
		connectFactory: () => {
			throw new Error("ENOENT");
		},
		reconnectBaseDelayMs: 1000,
	});
	const { ctx, statuses, notifications } = fakeCtx();
	const sessionStart = events.get("session_start");
	assert.ok(sessionStart);
	assert.doesNotThrow(() => sessionStart({}, ctx));
	assert.ok(statuses.some((status) => status.text === "[warning]remote-pi: unavailable"));
	const statusCommand = commands.get("remote-pi-status");
	assert.ok(statusCommand);
	await statusCommand.handler("", ctx);
	assert.ok(notifications.at(-1)?.message.includes("Bridge approval dialogs: unsupported"));
});

test("bridge reconnect uses bounded jittered backoff and re-registers without replaying commands", async () => {
	const sockets: FakeSocket[] = [];
	const bridge = new RemotePiBridgeClient({
		connectFactory: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			setImmediate(() => (sockets.length === 1 ? socket.emit("error", new Error("missing daemon")) : socket.emit("connect")));
			return socket;
		},
		reconnectBaseDelayMs: 5,
		reconnectMaxDelayMs: 5,
		reconnectJitterRatio: 0,
		random: () => 0,
	});
	const { pi } = fakePi();
	const { ctx } = fakeCtx();
	bridge.start(pi as any, ctx as any);
	await wait(30);
	assert.equal(sockets.length >= 2, true);
	assert.equal(records(sockets[1]).filter((record) => record.type === "bridge.register").length, 1);
});

test("shutdown is idempotent and reports terminal local shutdown once", async () => {
	const socket = new FakeSocket();
	const { pi } = fakePi();
	const { ctx } = fakeCtx();
	const bridge = new RemotePiBridgeClient({ connectFactory: () => socket });
	bridge.start(pi as any, ctx as any);
	socket.emit("connect");
	sendRegistered(socket);
	bridge.shutdown("quit");
	bridge.shutdown("quit");
	await wait();
	assert.equal(socket.ended, true);
	const events = records(socket).filter((record) => record.type === "bridge.event").map((record) => record.payload.event);
	assert.equal(events.filter((event) => event.type === "session.disconnected").length, 1);
	assert.equal(events.filter((event) => event.type === "session.state" && event.payload.state === "exited").length, 1);
});
