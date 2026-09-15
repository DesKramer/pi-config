import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { encodeJsonlRecord, StrictLfJsonlParser } from "../extensions/remote-pi/jsonl.ts";
import { REMOTE_PI_PROTOCOL_VERSION, createAttachedCapabilityMap } from "../extensions/remote-pi/protocol.ts";
import { RemotePiBridgeClient, createRemotePiExtension, type SocketLike } from "../extensions/remote-pi/index.ts";
import { resolveBridgeSocketPath } from "../extensions/remote-pi/paths.ts";

test("bridge keeps the macOS default and uses Linux XDG data paths", () => {
	assert.equal(resolveBridgeSocketPath("darwin", "/Users/demo", { XDG_DATA_HOME: "/xdg" }), "/Users/demo/Library/Application Support/remote-pi/bridge.sock");
	assert.equal(resolveBridgeSocketPath("linux", "/home/demo", { XDG_DATA_HOME: "/data with spaces" }), "/data with spaces/remote-pi/bridge.sock");
	for (const env of [{}, { XDG_DATA_HOME: "" }, { XDG_DATA_HOME: "relative" }]) {
		assert.equal(resolveBridgeSocketPath("linux", "/home/demo", env), "/home/demo/.local/share/remote-pi/bridge.sock");
	}
});

test("bridge socket and data overrides match daemon precedence on both hosts", () => {
	for (const platform of ["darwin", "linux"] as const) {
		const env = { XDG_DATA_HOME: "/xdg", REMOTE_PI_DATA_DIR: "/custom data" };
		assert.equal(resolveBridgeSocketPath(platform, "/home/demo", env), "/custom data/bridge.sock");
		assert.equal(resolveBridgeSocketPath(platform, "/home/demo", { ...env, REMOTE_PI_BRIDGE_SOCKET: "/private/bridge.sock" }), "/private/bridge.sock");
	}
});

test("bridge resolves environment at construction and explicit options still win", (t) => {
	const previous = process.env.REMOTE_PI_BRIDGE_SOCKET;
	t.after(() => {
		if (previous === undefined) delete process.env.REMOTE_PI_BRIDGE_SOCKET;
		else process.env.REMOTE_PI_BRIDGE_SOCKET = previous;
	});
	process.env.REMOTE_PI_BRIDGE_SOCKET = "/env/bridge.sock";
	assert.equal(new RemotePiBridgeClient().getSocketPath(), "/env/bridge.sock");
	assert.equal(new RemotePiBridgeClient({ socketPath: "/explicit/bridge.sock" }).getSocketPath(), "/explicit/bridge.sock");
});

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

function sendRegistered(socket: FakeSocket, sessionId = "remote-session-1", heartbeatIntervalMs = 5000, commandTimeoutMs = 30000, compactTextDeltas?: unknown) {
	socket.emit(
		"data",
		encodeJsonlRecord({
			protocolVersion: REMOTE_PI_PROTOCOL_VERSION,
			type: "bridge.registered",
			bridgeId: "daemon",
			sessionId,
			bridgeSequence: 1,
			timestamp: new Date().toISOString(),
			payload: { sessionId, heartbeatIntervalMs, commandTimeoutMs, acceptedProtocolVersion: REMOTE_PI_PROTOCOL_VERSION, ...(compactTextDeltas !== undefined ? { compactTextDeltas } : {}) },
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
		const fixture = readFileSync(new URL(`../../remote-pi/docs/fixtures/protocol/v1/bridge/${name}`, import.meta.url), "utf8");
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
	bridge.onMessageStart({ type: "message_start", message: structuredClone(assistant) } as any, ctx as any);
	bridge.onMessageUpdate({ type: "message_update", message: structuredClone(assistant), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi", partial: structuredClone(assistant) } } as any, ctx as any);
	bridge.onToolStart({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "pwd" } } as any, ctx as any);
	bridge.onToolUpdate({ type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "/tmp" }] } } as any, ctx as any);
	bridge.onToolEnd({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: { content: [{ type: "text", text: "/tmp" }] }, isError: false } as any, ctx as any);
	bridge.onMessageEnd({ type: "message_end", message: structuredClone(assistant) } as any, ctx as any);
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

test("extension registration exposes the actual socket in status and fails open when daemon is unavailable", async () => {
	const socketPath = "/private/custom data/bridge.sock";
	const attemptedPaths: string[] = [];
	const { events, commands } = registerExtension({
		socketPath,
		connectFactory: (socketPath) => {
			attemptedPaths.push(socketPath);
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
	assert.ok(notifications.at(-1)?.message.includes(`Socket: ${socketPath}\n`));
	assert.deepEqual(attemptedPaths, [socketPath]);
	events.get("session_shutdown")?.({ reason: "quit" }, ctx);
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

test("compact text negotiation preserves multiblock deltas, fallback partials, and completions", async () => {
	const sockets: FakeSocket[] = [];
	const { pi } = fakePi();
	const { ctx } = fakeCtx();
	const bridge = new RemotePiBridgeClient({ connectFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, reconnectBaseDelayMs: 1, reconnectJitterRatio: 0 });
	bridge.start(pi as any, ctx as any);
	const socket = sockets[0]!;
	socket.emit("connect");
	assert.equal(records(socket)[0].payload.compactTextDeltas, true);
	const message = { role: "assistant", content: [{ type: "text", text: "First\n" }, { type: "text", text: "\nSecond" }] };
	const update = (delta: Record<string, unknown>) => bridge.onMessageUpdate({ message: structuredClone(message), assistantMessageEvent: { ...delta, partial: structuredClone(message) } }, ctx as any);
	try {
		for (const acknowledgement of [undefined, false, "true"]) {
			sendRegistered(socket, "remote-session-1", 5000, 30000, acknowledgement);
			bridge.onMessageStart({ message: structuredClone(message) }, ctx as any);
			update({ type: "text_delta", delta: "old peer" });
			assert.deepEqual(records(socket).at(-1).payload.event.payload.partial, message);
			bridge.onMessageEnd({ message: structuredClone(message) }, ctx as any);
		}
		sendRegistered(socket, "remote-session-1", 5000, 30000, true);
		bridge.onMessageStart({ message }, ctx as any);
		const start = records(socket).at(-1).payload.event.payload;
		const text: string[] = [];
		for (const [contentIndex, delta] of [[0, "First\n"], [1, "\nSecond"], [1, ""]] as const) {
			update({ type: "text_delta", contentIndex, delta });
			const payload = records(socket).at(-1).payload.event.payload;
			assert.equal("partial" in payload, false);
			assert.equal(payload.contentIndex, contentIndex);
			assert.equal(payload.messageId, start.messageId);
			text.push(payload.delta);
		}
		assert.equal(text.join(""), "First\n\nSecond");
		for (const delta of [{ type: "text_delta" }, { type: "text_delta", delta: 1 }, { type: "thinking_delta", delta: "hmm" }, { type: "toolcall_delta", delta: "{" }, { type: "unknown", delta: "x" }]) {
			update(delta);
			assert.deepEqual(records(socket).at(-1).payload.event.payload.partial, message);
		}
		bridge.onMessageEnd({ message }, ctx as any);
		assert.deepEqual(records(socket).at(-1).payload.event.payload.message, message);
		socket.destroy();
		await wait(10);
		assert.equal(sockets.length, 2);
		bridge.onMessageStart({ message: structuredClone(message) }, ctx as any);
		update({ type: "text_delta", delta: "before re-registration" });
		assert.deepEqual(records(sockets[1]!).at(-1).payload.event.payload.partial, message);
	} finally { bridge.shutdown(); }
});

test("cloned message lifecycles keep one row per message across thinking, text blocks, and identical answers", () => {
	for (const compact of [false, true]) {
		const socket = new FakeSocket();
		const { pi } = fakePi();
		const { ctx } = fakeCtx();
		const bridge = new RemotePiBridgeClient({ connectFactory: () => socket });
		bridge.start(pi as any, ctx as any);
		socket.emit("connect");
		sendRegistered(socket, "remote-session-1", 5000, 30000, compact);
		const start = (message: unknown) => bridge.onMessageStart({ message: structuredClone(message) }, ctx as any);
		const end = (message: unknown) => bridge.onMessageEnd({ message: structuredClone(message) }, ctx as any);
		const assistant = {
			role: "assistant", content: [] as any[], timestamp: 123,
			api: "openai-responses", provider: "openai", model: "gpt-5", stopReason: "pending",
			usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const update = (message: unknown, delta: Record<string, unknown>) => bridge.onMessageUpdate({
			message: structuredClone(message), assistantMessageEvent: { ...delta, partial: structuredClone(message) },
		}, ctx as any);
		try {
			bridge.onAgentStart(ctx as any);
			const user = { role: "user", content: "Repeat the answer", timestamp: 123 };
			start(user);
			end(user);
			const custom = { role: "custom", customType: "context", content: "Repeat the answer", display: true, timestamp: 123 };
			start(custom);
			end(custom);
			// Repeated content and timestamps are deliberately identical. Starts,
			// not text, timestamps, object references, or run IDs, separate messages.
			for (let i = 0; i < 2; i++) {
				const message = structuredClone(assistant);
				start(message);
				message.content.push({ type: "thinking", thinking: "" });
				update(message, { type: "thinking_start", contentIndex: 0 });
				message.content[0].thinking = "Consider this";
				update(message, { type: "thinking_delta", contentIndex: 0, delta: "Consider this" });
				update(message, { type: "thinking_end", contentIndex: 0 });
				for (const [contentIndex, chunks] of [[1, ["First", " block\n"]], [2, ["Second", " block", ""]]] as const) {
					message.content.push({ type: "text", text: "" });
					update(message, { type: "text_start", contentIndex });
					for (const delta of chunks) {
						message.content[contentIndex].text += delta;
						update(message, { type: "text_delta", contentIndex, delta });
					}
					update(message, { type: "text_end", contentIndex });
				}
				message.stopReason = "stop";
				message.usage.output = 8;
				message.usage.totalTokens = 18;
				end(message);
			}
			const events = records(socket).flatMap((r) => r.type === "bridge.event" && r.payload.event.type.startsWith("message.") ? [r.payload.event] : []);
			const starts = events.filter((e) => e.type === "message.started");
			assert.deepEqual(starts.map((e) => e.payload.role), ["user", "custom", "assistant", "assistant"]);
			assert.equal(new Set(starts.map((e) => e.payload.messageId)).size, 4);
			assert.equal(new Set(starts.map((e) => e.payload.runId)).size, 1);
			// Model a consumer keyed by the authoritative start ID. Completions
			// replace partial content rather than adding a second answer row.
			const rows = new Map<string, any>();
			for (const event of events) {
				const payload = event.payload;
				if (event.type === "message.started") rows.set(payload.messageId, { role: payload.role, blocks: [] });
				const row = rows.get(payload.messageId);
				assert.ok(row, "every delta and completion must have a preceding start");
				assert.equal(payload.runId, starts[0].payload.runId);
				assert.equal(event.causation.runId, payload.runId);
				if (event.type === "message.delta") {
					if (payload.deltaType === "text_delta") {
						assert.equal("partial" in payload, !compact);
						row.blocks[payload.contentIndex] = (row.blocks[payload.contentIndex] ?? "") + payload.delta;
					} else assert.equal(payload.partial.role, "assistant");
				} else if (event.type === "message.completed") {
					row.message = payload.message;
					if (row.role === "assistant") {
						assert.equal(row.blocks[1], "First block\n");
						assert.equal(row.blocks[2], "Second block");
						assert.deepEqual(payload.message.content, [{ type: "thinking", thinking: "Consider this" }, { type: "text", text: "First block\n" }, { type: "text", text: "Second block" }]);
						assert.equal(payload.message.usage.output, 8);
					}
				}
			}
			assert.equal(rows.size, 4);
			assert.ok([...rows.values()].every((row) => row.message));
			assert.equal(events.filter((e) => e.type === "message.completed").length, 4);
		} finally { bridge.shutdown(); }
	}
});

test("parallel tool execution does not steal message identities from ordered tool results or the next assistant", () => {
	const socket = new FakeSocket();
	const { pi } = fakePi();
	const { ctx } = fakeCtx();
	const bridge = new RemotePiBridgeClient({ connectFactory: () => socket });
	bridge.start(pi as any, ctx as any);
	socket.emit("connect");
	sendRegistered(socket);
	const pair = (message: unknown) => {
		bridge.onMessageStart({ message: structuredClone(message) }, ctx as any);
		bridge.onMessageEnd({ message: structuredClone(message) }, ctx as any);
	};
	try {
		bridge.onAgentStart(ctx as any);
		const calls = ["call-1", "call-2"].map((id) => ({ type: "toolCall", id, name: "bash", arguments: { command: "pwd" } }));
		pair({ role: "assistant", content: calls, stopReason: "toolUse" });
		for (const call of calls) bridge.onToolStart({ toolCallId: call.id, toolName: call.name, args: call.arguments }, ctx as any);
		const result = { content: [{ type: "text", text: "/tmp" }] };
		for (const call of [...calls].reverse()) {
			bridge.onToolUpdate({ toolCallId: call.id, toolName: call.name, partialResult: result }, ctx as any);
			bridge.onToolEnd({ toolCallId: call.id, toolName: call.name, result, isError: false }, ctx as any);
		}
		for (const call of calls) pair({ role: "toolResult", toolCallId: call.id, toolName: call.name, ...result, isError: false, timestamp: 123 });
		pair({ role: "assistant", content: result.content, stopReason: "stop" });
		const events = records(socket).filter((r) => r.type === "bridge.event").map((r) => r.payload.event);
		const starts = events.filter((e) => e.type === "message.started");
		const ends = events.filter((e) => e.type === "message.completed");
		assert.deepEqual(starts.map((e) => e.payload.role), ["assistant", "toolResult", "toolResult", "assistant"]);
		assert.equal(new Set(starts.map((e) => e.payload.messageId)).size, 4);
		assert.deepEqual(ends.map((e) => e.payload.messageId), starts.map((e) => e.payload.messageId));
		assert.deepEqual(ends.filter((e) => e.payload.role === "toolResult").map((e) => e.payload.message.toolCallId), ["call-1", "call-2"]);
		assert.deepEqual(events.filter((e) => e.type === "tool.completed").map((e) => e.payload.toolCallId), ["call-2", "call-1"]);
	} finally { bridge.shutdown(); }
});

test("message lifecycle guards ignore unmatched and repeated events and reset at run and session boundaries", () => {
	const socket = new FakeSocket();
	const { pi } = fakePi();
	const { ctx } = fakeCtx();
	const bridge = new RemotePiBridgeClient({ connectFactory: () => socket });
	bridge.start(pi as any, ctx as any);
	socket.emit("connect");
	sendRegistered(socket);
	const message = { role: "assistant", content: [{ type: "text", text: "same" }], stopReason: "aborted" };
	const start = () => bridge.onMessageStart({ message: structuredClone(message) }, ctx as any);
	const end = () => bridge.onMessageEnd({ message: structuredClone(message) }, ctx as any);
	const update = () => bridge.onMessageUpdate({ message: structuredClone(message), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "same" } }, ctx as any);
	const messages = () => records(socket).flatMap((r) => r.type === "bridge.event" && r.payload.event.type.startsWith("message.") ? [r.payload.event] : []);
	try {
		update(); end();
		assert.equal(messages().length, 0);
		bridge.onAgentStart(ctx as any);
		start(); start(); update(); end(); end(); update();
		assert.deepEqual(messages().map((e) => e.type), ["message.started", "message.delta", "message.completed"]);
		assert.equal(messages()[2].payload.isError, true);
		for (const boundary of [
			() => bridge.onAgentEnd({ messages: [] } as any, ctx as any),
			() => bridge.onAgentStart(ctx as any),
			() => bridge.onAgentSettled(ctx as any),
			() => bridge.start(pi as any, ctx as any),
		]) {
			start();
			boundary();
			const count = messages().length;
			update(); end();
			assert.equal(messages().length, count);
			start(); end();
		}
		const starts = messages().filter((e) => e.type === "message.started");
		assert.equal(new Set(starts.map((e) => e.payload.messageId)).size, starts.length);
		start();
		bridge.shutdown("reload");
		const count = messages().length;
		start(); update(); end();
		assert.equal(messages().length, count);
	} finally { bridge.shutdown(); }
});

test("an active cloned message keeps its start ID and run across reconnect and re-registration", async () => {
	const sockets: FakeSocket[] = [];
	const { pi } = fakePi();
	const { ctx } = fakeCtx();
	const bridge = new RemotePiBridgeClient({ connectFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, reconnectBaseDelayMs: 1, reconnectJitterRatio: 0 });
	bridge.start(pi as any, ctx as any);
	const socket = sockets[0]!;
	socket.emit("connect");
	sendRegistered(socket, "remote-session-1", 5000, 30000, true);
	try {
		bridge.onAgentStart(ctx as any);
		const message = { role: "assistant", content: [{ type: "text", text: "Hello" }] };
		bridge.onMessageStart({ message: structuredClone(message) }, ctx as any);
		const started = records(socket).at(-1).payload.event.payload;
		socket.destroy();
		await wait(10);
		const reconnected = sockets[1]!;
		reconnected.emit("connect");
		sendRegistered(reconnected);
		bridge.onMessageUpdate({ message: structuredClone(message), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: structuredClone(message) } }, ctx as any);
		const delta = records(reconnected).at(-1).payload.event.payload;
		assert.equal(delta.messageId, started.messageId);
		assert.equal(delta.runId, started.runId);
		assert.deepEqual(delta.partial, message, "reconnect resets negotiation, not message identity");
		bridge.onMessageEnd({ message: structuredClone({ ...message, stopReason: "stop" }) }, ctx as any);
		const completed = records(reconnected).at(-1).payload.event.payload;
		assert.equal(completed.messageId, started.messageId);
		assert.equal(completed.runId, started.runId);
		assert.equal(records(reconnected).filter((r) => r.payload.event?.type === "message.started").length, 0, "reconnect must not invent another start");
	} finally { bridge.shutdown(); }
});

test("heartbeats preserve settling until agent_settled", async () => {
	const socket = new FakeSocket();
	const { pi } = fakePi();
	const { ctx } = fakeCtx();
	const bridge = new RemotePiBridgeClient({ connectFactory: () => socket });
	bridge.start(pi as any, ctx as any);
	socket.emit("connect");
	sendRegistered(socket, "remote-session-1", 5);
	try {
		bridge.onAgentStart(ctx as any);
		bridge.onAgentEnd({ messages: [] } as any, ctx as any);
		await wait(15);
		assert.equal(records(socket).filter((r) => r.type === "bridge.heartbeat").at(-1).payload.state, "settling");
		bridge.onAgentSettled(ctx as any);
		await wait(15);
		assert.equal(records(socket).filter((r) => r.type === "bridge.heartbeat").at(-1).payload.state, "idle");
	} finally { bridge.shutdown(); }
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
