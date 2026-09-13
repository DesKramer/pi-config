import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ContextEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import retry from "../extensions/retry.ts";

const failure = () => fauxAssistantMessage("Incomplete response", {
	stopReason: "error",
	errorMessage: "fetch failed",
});

function harness(sm = SessionManager.inMemory()) {
	let command!: RegisteredCommand;
	let filter!: (event: ContextEvent) => { messages: ContextEvent["messages"] };
	const sent: Parameters<ExtensionAPI["sendMessage"]>[] = [];
	const notifications: string[] = [];
	retry({
		registerCommand: (name: string, definition: RegisteredCommand) => {
			assert.equal(name, "retry");
			command = definition;
		},
		on: (name: string, handler: typeof filter) => {
			assert.equal(name, "context");
			filter = handler;
		},
		sendMessage: (...args: Parameters<ExtensionAPI["sendMessage"]>) => { sent.push(args); },
	} as unknown as ExtensionAPI);
	const state = { idle: true, pending: false };
	const ctx = {
		sessionManager: sm,
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		ui: { notify: (message: string) => { notifications.push(message); } },
	} as unknown as ExtensionCommandContext;
	return {
		sm, state, sent, notifications,
		run: (args = "") => command.handler(args, ctx),
		filter: (messages: ContextEvent["messages"]) => filter({ type: "context", messages }).messages,
	};
}

function failedSession() {
	const sm = SessionManager.inMemory();
	sm.appendMessage({ role: "user", content: "Finish the task", timestamp: 1 });
	sm.appendMessage(failure());
	return sm;
}

test("retry starts one hidden turn without resending user input", async () => {
	const h = harness(failedSession());
	await h.run();
	assert.equal(h.sent.length, 1);
	assert.deepEqual(h.sent[0][1], { triggerTurn: true });
	assert.equal(h.sent[0][0].display, false);
	assert.deepEqual(h.sent[0][0].content, []);
	assert.equal(h.sm.getBranch().length, 2);
});

test("retry rejects busy sessions, pending messages, and arguments", async () => {
	const h = harness(failedSession());
	h.state.idle = false;
	await h.run();
	h.state.idle = true;
	h.state.pending = true;
	await h.run();
	h.state.pending = false;
	await h.run("something");
	assert.equal(h.sent.length, 0);
	assert.equal(h.notifications.length, 3);
});

test("retry rejects empty, successful, aborted, and superseded failures", async () => {
	const h = harness();
	await h.run();
	h.sm.appendMessage({ role: "user", content: "Hello", timestamp: 1 });
	await h.run();
	h.sm.appendMessage(failure());
	h.sm.appendMessage(fauxAssistantMessage("Done"));
	await h.run();
	h.sm.appendMessage(fauxAssistantMessage("", { stopReason: "aborted" }));
	await h.run();
	h.sm.appendMessage(failure());
	h.sm.appendMessage({ role: "user", content: "A different task", timestamp: 2 });
	await h.run();
	assert.equal(h.sent.length, 0);
});

test("retry follows the active branch and works in a fresh extension instance", async () => {
	const sm = failedSession();
	const failedLeaf = sm.getLeafId()!;
	sm.appendMessage(fauxAssistantMessage("Recovered"));
	const h = harness(sm);
	await h.run();
	assert.equal(h.sent.length, 0);
	sm.branch(failedLeaf);
	await h.run();
	assert.equal(h.sent.length, 1);
	const reloaded = harness(sm);
	await reloaded.run();
	assert.equal(reloaded.sent.length, 1);
});

test("metadata does not hide a failure, but new model-visible content does", async () => {
	const h = harness(failedSession());
	h.sm.appendSessionInfo("Network recovery");
	h.sm.appendModelChange("faux", "faux");
	h.sm.appendCustomEntry("status", { connected: true });
	await h.run();
	assert.equal(h.sent.length, 1);
	h.sm.appendCustomMessageEntry("another-extension", "New task", false);
	await h.run();
	assert.equal(h.sent.length, 1);
});

test("context removes retry markers and failed partial responses, preserving successful work", async () => {
	const h = harness(failedSession());
	await h.run();
	const marker = { ...h.sent[0][0], role: "custom" as const, timestamp: 3 };
	const user = h.sm.buildSessionContext().messages[0];
	const toolCall = fauxAssistantMessage(fauxToolCall("write", {}, { id: "write-1" }), { stopReason: "toolUse" });
	const result = {
		role: "toolResult" as const, toolCallId: "write-1", toolName: "write",
		content: [{ type: "text" as const, text: "Written" }], isError: false, timestamp: 2,
	};
	const success = fauxAssistantMessage("Finished");
	const messages = [user, toolCall, result, failure(), failure(), marker, failure(), marker, success];
	const original = structuredClone(messages);
	assert.deepEqual(h.filter(messages), [user, toolCall, result, success]);
	assert.deepEqual(messages, original, "session history must not be mutated");
	assert.deepEqual(h.filter([user, messages[3]]), [user, messages[3]], "unrelated failures are untouched");
});

test("a hidden marker left by a failed retry does not prevent another retry", async () => {
	const h = harness(failedSession());
	await h.run();
	const marker = h.sent[0][0];
	h.sm.appendCustomMessageEntry(marker.customType, marker.content, marker.display);
	await h.run();
	assert.equal(h.sent.length, 2);
});

test("retry reads compacted context rather than an old branch failure", async () => {
	const h = harness(failedSession());
	const user = h.sm.appendMessage({ role: "user", content: "Next task", timestamp: 4 });
	h.sm.appendMessage(fauxAssistantMessage("Done"));
	h.sm.appendCompaction("Earlier work", user, 100);
	await h.run();
	assert.equal(h.sent.length, 0);
	h.sm.appendMessage(failure());
	await h.run();
	assert.equal(h.sent.length, 1);
});

test("real Pi session retries exhausted fetch failures without repeating tools or images", { timeout: 30_000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-retry-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
	});
	const faux = fauxProvider({
		tokensPerSecond: Infinity,
		models: [{ id: "faux-1", input: ["text", "image"] }],
	});
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir, agentDir: dir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi) => {
			pi.registerProvider("faux", {
				api: faux.api, apiKey: "test-only", baseUrl: "https://unused.invalid",
				models: faux.models,
				streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, options),
			});
		}, retry],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	let toolRuns = 0;
	const { session } = await createAgentSession({
		cwd: dir, agentDir: dir, modelRuntime, resourceLoader, settingsManager,
		model: faux.getModel(), sessionManager: SessionManager.inMemory(dir),
		tools: ["count"],
		customTools: [{
			name: "count", label: "Count", description: "Count executions", parameters: Type.Object({}),
			async execute() {
				toolRuns++;
				return { content: [{ type: "text", text: "Executed once" }], details: {} };
			},
		}],
	});
	t.after(() => session.dispose());
	const extensionErrors: unknown[] = [];
	await session.bindExtensions({ onError: (error) => { extensionErrors.push(error); } });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("count", {}, { id: "count-1" }), { stopReason: "toolUse" }),
		failure(), failure(), failure(),
		failure(), failure(), failure(),
		(context) => {
			assert.deepEqual(context.messages.map((message) => message.role), ["user", "assistant", "toolResult"]);
			assert.equal(context.messages[1].role === "assistant" && context.messages[1].stopReason, "toolUse");
			assert.deepEqual(context.messages[0], userBefore);
			assert.equal(toolRuns, 1);
			return fauxAssistantMessage("Recovered");
		},
	]);
	await session.prompt("Count once and describe the image", {
		images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
	});
	assert.equal(faux.state.callCount, 4);
	assert.equal(session.isIdle, true);
	const userBefore = structuredClone(session.messages.find((message) => message.role === "user"));
	await session.prompt("/retry");
	await session.waitForIdle();
	assert.equal(faux.state.callCount, 7, "a manual retry may exhaust automatic retries again");
	await session.prompt("/retry");
	await session.waitForIdle();
	assert.equal(faux.state.callCount, 8);
	assert.equal(toolRuns, 1);
	assert.deepEqual(session.messages.filter((message) => message.role === "user"), [userBefore]);
	const last = session.messages.at(-1);
	assert.ok(last?.role === "assistant");
	assert.equal(last.stopReason, "stop", last.errorMessage);
	assert.deepEqual(last.content, [{ type: "text", text: "Recovered" }]);
	await session.prompt("/retry");
	await session.waitForIdle();
	assert.equal(faux.state.callCount, 8, "a successful request must not be retried");
	assert.deepEqual(extensionErrors, []);
});
