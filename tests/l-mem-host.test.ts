import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedSession, piSdk } from "../extensions/l-mem/evaluation/pi-session.ts";
import { FakeModel } from "../extensions/l-mem/testing.ts";
import { canonical, readJson, SqliteStore, digest } from "../extensions/l-mem/storage.ts";
import { SessionMemory } from "../extensions/l-mem/memory.ts";
import { captureBranch } from "../extensions/l-mem/pi-adapter.ts";
import { getPiMemoryHost } from "../extensions/l-mem/host-runtime.ts";
import { nativeHost, nativeTokenizer, restoredMessages, validateMessages } from "../extensions/l-mem/native-context.ts";
import lMem from "../extensions/l-mem/index.ts";
import { WRITER_PROMPT, BLOCK_PROMPT, REVIEWER_PROMPT, TRAJECTORY_PROMPT } from "../extensions/l-mem/prompts.ts";

const runSdk = !!process.env.L_MEM_PI_PACKAGE;
async function backend(directory: string, response: (context: any, call: number) => any[], skipPayload = false) {
	const sdk = await piSdk();
	const runtime = await sdk.ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models-store.json"), refreshOnCreate: false });
	const contexts: any[] = [];
	runtime.registerProvider("l-mem-contract", { api: "openai-responses", apiKey: "test-only", baseUrl: "http://unused.invalid", models: ["contract", "other"].map(id => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 })),
		streamSimple: async (model: any, context: any, options: any) => {
			if (!skipPayload) await options.onPayload?.({ model: model.id, instructions: context.systemPrompt, input: context.messages, tools: (context.tools ?? []).map((t: any) => ({ name: t.name, parameters: t.parameters })) }, model);
			contexts.push(structuredClone(context.messages));
			const content = response(context, contexts.length);
			const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason: content.some(p => p.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(), usage: { input: 10, output: 10, reasoning: content.some(p => p.type === "thinking") ? 7 : 0, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			return { result: async () => message, async *[Symbol.asyncIterator]() { yield { type: "start", partial: message }; yield { type: "done", reason: message.stopReason, message }; } };
		},
	});
	return { runtime, model: runtime.getModel("l-mem-contract", "contract"), contexts };
}

// Drive the public commands against the real private SDK host. Both main and memory providers are scripted.
function extensionControls(fixture: Awaited<ReturnType<typeof isolatedSession>>, startupMode = "off") {
	const handlers = new Map<string, Function>(), notices: string[] = [], statuses = new Map<string, string | undefined>();
	const writer = new FakeModel(), tools = ["read", "bash", "edit", "write"];
	let command: any, flag = startupMode;
	lMem({ registerFlag() {}, getFlag: () => flag, getActiveTools: () => tools, on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand: (_name: string, value: any) => { command = value; } } as any);
	const prompts = { writer: WRITER_PROMPT, block: BLOCK_PROMPT, reviewer: REVIEWER_PROMPT, trajectory: TRAJECTORY_PROMPT };
	const ctx = {
		hasUI: true, ui: { notify: (text: string) => notices.push(text), setStatus: (key: string, text: string | undefined) => statuses.set(key, text) },
		sessionManager: fixture.session.sessionManager, get model() { return fixture.session.agent.state.model; }, isIdle: () => !fixture.session.isStreaming,
		modelRegistry: { async complete(_model: any, context: any, options: any) {
			assert.equal(options.transport, "sse"); assert.equal(options.maxRetries, 0); assert.deepEqual(context.tools, []);
			const kind = (Object.keys(prompts) as (keyof typeof prompts)[]).find(kind => prompts[kind] === context.systemPrompt); assert.ok(kind);
			const output = await writer.invoke({ kind, prompt: context.systemPrompt, input: JSON.parse(context.messages[0].content[0].text), maxOutputTokens: options.maxTokens, signal: options.signal });
			return { role: "assistant", stopReason: "stop", content: [{ type: "text", text: canonical(output) }] };
		} },
	};
	return { command, ctx, tools, handlers, notices, statuses, writer, setFlag: (value: string) => { flag = value; }, archive: join(fixture.session.sessionManager.getSessionDir(), "l-mem") };
}

for (const entry of ["command", "startup"] as const) test(`experimental ${entry} enables actual SDK dispatch without acceptance and keeps normal enable gated`, { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-experimental-"));
	const b = await backend(directory, (_ctx, call) => call === 1 ? [{ type: "toolCall", id: "experimental-write-once", name: "write", arguments: { path: "answer.txt", content: "one execution" } }] : [{ type: "text", text: "Written." }]);
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()), f = extensionControls(fixture);
	let probe: SqliteStore | undefined;
	const report = process.env.L_MEM_ACCEPTANCE_REPORT; delete process.env.L_MEM_ACCEPTANCE_REPORT;
	t.after(async () => { await f.command.handler("off", f.ctx); probe?.close(); fixture.close(); await rm(directory, { recursive: true, force: true }); if (report === undefined) delete process.env.L_MEM_ACCEPTANCE_REPORT; else process.env.L_MEM_ACCEPTANCE_REPORT = report; });
	fixture.session.settingsManager.applyOverrides({ compaction: { enabled: true }, retry: { enabled: true } });
	const system = fixture.session.agent.state.systemPrompt, tools = fixture.session.agent.state.tools;
	if (entry === "command") await f.command.handler("experimental", f.ctx);
	else { f.setFlag("experimental"); await f.handlers.get("session_start")!({ reason: "startup" }, f.ctx); }
	assert.ok(f.notices.some(text => /EXPERIMENTAL live memory/.test(text) && /additional model quota/.test(text)));
	assert.match(f.notices.at(-1)!, /EXPERIMENTAL live replacement enabled/);
	assert.match(f.statuses.get("l-mem")!, /EXPERIMENTAL/);
	assert.equal(fixture.session.settingsManager.getCompactionSettings().enabled, false);
	assert.equal(b.contexts.length, 0); assert.equal(f.writer.calls.length, 0);
	await f.command.handler("enable", f.ctx); assert.match(f.notices.at(-1)!, /L_MEM_ACCEPTANCE_REPORT/);
	await f.command.handler("status", f.ctx); assert.match(f.notices.at(-1)!, /Mode: experimental; LIVE replacement.*NOT release-validated/);
	await f.command.handler("compact", f.ctx); assert.match(f.notices.at(-1)!, /Compaction requested/);
	await fixture.session.prompt("Write answer.txt once.");
	assert.equal(await readFile(join(fixture.cwd, "answer.txt"), "utf8"), "one execution");
	assert.equal(b.contexts.length, 2);
	assert.equal(fixture.session.agent.state.systemPrompt, system); assert.deepEqual(fixture.session.agent.state.tools, tools);
	assert.ok(b.contexts.every(messages => /Historical conversation data/.test(canonical(messages[0]))));
	probe = new SqliteStore(f.archive);
	const state = probe.load(fixture.sessionId).state;
	assert.equal(state.host!.dispatches.length, 2); assert.ok(state.host!.dispatches.every(d => d.state === "complete" && d.providerPayloadRef));
	assert.equal(state.events.filter(e => e.kind === "tool_request").length, 1);
	const before = canonical(probe.load(fixture.sessionId)), calls = f.writer.calls.length;
	await f.command.handler("status", f.ctx);
	assert.equal(canonical(probe.load(fixture.sessionId)), before); assert.equal(f.writer.calls.length, calls);
	await f.command.handler("off", f.ctx);
	assert.equal(f.statuses.get("l-mem"), undefined); assert.equal(fixture.session.settingsManager.getCompactionSettings().enabled, true); assert.equal(fixture.session.settingsManager.getRetrySettings().enabled, true);
	await f.command.handler("status", f.ctx); assert.match(f.notices.at(-1)!, /Mode: off/);
	assert.equal(probe.load(fixture.sessionId).state.host!.dispatches.length, 2);
});

test("experimental enable retains runtime, durability, tool, idle and provenance checks without paid fallback", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-experimental-checks-"));
	const b = await backend(directory, () => { throw new Error("Must not invoke the main model"); });
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()), f = extensionControls(fixture);
	t.after(async () => { await f.command.handler("off", f.ctx); fixture.close(); await rm(directory, { recursive: true, force: true }); });
	for (const [ctx, message] of [
		[{ ...f.ctx, model: undefined }, /select a main model/],
		[{ ...f.ctx, sessionManager: { getSessionId: () => "no-host" } }, /start pi with scripts\/l-mem-pi.ts/],
		[{ ...f.ctx, isIdle: () => false }, /finish the active turn/],
		[{ ...f.ctx, sessionManager: { getSessionId: () => fixture.sessionId, getSessionFile: () => undefined } }, /requires a durable session/],
	] as const) {
		await f.command.handler("experimental", ctx); assert.match(f.notices.at(-1)!, message);
		await f.command.handler("status", f.ctx); assert.match(f.notices.at(-1)!, /Mode: off/); assert.match(f.notices.at(-1)!, /Archive not open/);
	}
	f.tools.splice(0, 1); await f.command.handler("experimental", f.ctx); assert.match(f.notices.at(-1)!, /existing read tool must be active/); f.tools.unshift("read");
	fixture.session.sessionManager.appendMessage({ role: "user", content: "Old input without durable provenance", timestamp: 1 });
	await f.command.handler("experimental", f.ctx); assert.match(f.notices.at(-1)!, /history lacks durable user-input provenance/);
	await f.command.handler("status", f.ctx); assert.match(f.notices.at(-1)!, /Mode: off/); assert.match(f.notices.at(-1)!, /Archive not open/);
	assert.equal(b.contexts.length, 0); assert.equal(f.writer.calls.length, 0); assert.equal(f.statuses.get("l-mem"), undefined);
});

test("experimental opt-in expires on session shutdown and is not inherited by reload, new, resumed or forked sessions", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-experimental-scope-"));
	const b = await backend(directory, () => { throw new Error("Must not invoke the main model"); });
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()), f = extensionControls(fixture, "experimental");
	t.after(async () => { await f.command.handler("off", f.ctx); fixture.close(); await rm(directory, { recursive: true, force: true }); });
	await f.handlers.get("session_start")!({ reason: "startup" }, f.ctx); assert.match(f.notices.at(-1)!, /EXPERIMENTAL live replacement enabled/);
	await f.handlers.get("session_shutdown")!({ reason: "new" }, f.ctx);
	await f.handlers.get("session_start")!({ reason: "new" }, f.ctx);
	await f.command.handler("status", f.ctx); assert.match(f.notices.at(-1)!, /Mode: off/); assert.equal(f.statuses.get("l-mem"), undefined);
	for (const reason of ["reload", "new", "resume", "fork"]) {
		const fresh = extensionControls(fixture, "experimental");
		await fresh.handlers.get("session_start")!({ reason }, fresh.ctx);
		await fresh.command.handler("status", fresh.ctx);
		assert.match(fresh.notices.at(-1)!, /Mode: off/); assert.match(fresh.notices.at(-1)!, /Archive not open/);
		assert.equal(fresh.writer.calls.length, 0);
	}
	assert.equal(b.contexts.length, 0);
});

test("noninteractive experimental startup warns on stderr and failed startup stays off", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-experimental-stderr-"));
	const b = await backend(directory, () => { throw new Error("Must not invoke the main model"); });
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()), f = extensionControls(fixture, "experimental");
	const errors: string[] = [], previous = console.error; console.error = (text: string) => errors.push(text);
	f.ctx.hasUI = false;
	t.after(async () => { try { await f.command.handler("off", f.ctx); fixture.close(); await rm(directory, { recursive: true, force: true }); } finally { console.error = previous; } });
	await f.handlers.get("session_start")!({ reason: "startup" }, f.ctx);
	assert.ok(errors.some(text => /EXPERIMENTAL live memory/.test(text) && /additional model quota/.test(text)));
	assert.match(errors.at(-1)!, /EXPERIMENTAL live replacement enabled/); assert.equal(f.notices.length, 0);
	await f.command.handler("off", f.ctx);
	const failed = extensionControls(fixture, "experimental");
	await failed.handlers.get("session_start")!({ reason: "startup" }, { ...failed.ctx, sessionManager: { getSessionId: () => "no-host" } });
	assert.match(failed.notices.at(-1)!, /live startup failed; memory is OFF/);
	await failed.command.handler("status", failed.ctx); assert.match(failed.notices.at(-1)!, /Mode: off/); assert.match(failed.notices.at(-1)!, /Archive not open/);
	assert.equal(f.writer.calls.length, 0); assert.equal(failed.writer.calls.length, 0); assert.equal(b.contexts.length, 0);
});

test("experimental mode still blocks tools from an unjournaled provider response", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-experimental-payload-"));
	const b = await backend(directory, () => [{ type: "toolCall", id: "must-not-write", name: "write", arguments: { path: "answer.txt", content: "unsafe" } }], true);
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()), f = extensionControls(fixture);
	let probe: SqliteStore | undefined;
	t.after(async () => { await f.command.handler("off", f.ctx); probe?.close(); fixture.close(); await rm(directory, { recursive: true, force: true }); });
	await f.command.handler("experimental", f.ctx); await fixture.session.prompt("Do not execute unjournaled tools.");
	await assert.rejects(readFile(join(fixture.cwd, "answer.txt")), { code: "ENOENT" });
	probe = new SqliteStore(f.archive);
	const state = probe.load(fixture.sessionId).state;
	assert.equal(b.contexts.length, 1); assert.equal(state.host!.dispatches.length, 1); assert.equal(state.host!.dispatches[0].state, "accepted");
	assert.equal(state.host!.dispatches[0].providerPayloadRef, undefined);
});

test("native protocol validator requires complete sibling tool results", () => {
	assert.throws(() => validateMessages([{ role: "assistant", content: [{ type: "toolCall", id: "a" }, { type: "toolCall", id: "b" }] }, { role: "toolResult", toolCallId: "b" }]), /Outstanding/);
});

test("patched SDK dispatches real pi tools once, preserves prompt/catalog, and journals the actual payload", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const b = await backend(directory, (_ctx, call) => call === 1 ? [{ type: "toolCall", id: "write-once", name: "write", arguments: { path: "answer.txt", content: "one execution" } }] : [{ type: "text", text: "The file was written." }]);
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()); t.after(() => fixture.close());
	const prompt = fixture.session.agent.state.systemPrompt;
	const tools = fixture.session.agent.state.tools.map((tool: any) => tool.name);
	fixture.host.enable();
	await fixture.session.prompt("Write answer.txt once.");
	assert.equal(await readFile(join(fixture.cwd, "answer.txt"), "utf8"), "one execution");
	assert.equal(b.contexts.length, 2);
	assert.equal(fixture.session.agent.state.systemPrompt, prompt);
	assert.deepEqual(fixture.session.agent.state.tools.map((tool: any) => tool.name), tools);
	const state = fixture.store.load(fixture.sessionId).state;
	assert.equal(state.host!.dispatches.length, 2);
	assert.ok(state.host!.dispatches.every(d => d.state === "complete" && d.providerPayloadRef));
	assert.equal(state.events.filter(e => e.kind === "tool_request").length, 1);
	assert.ok(state.events.filter(e => e.kind === "user_message").every(e => e.origin === "original"));
	assert.ok(b.contexts.every(messages => messages[0].role === "assistant" && canonical(messages[0]).includes("Historical conversation data")));
});

test("the actual SDK can read an index page without overflowing or dropping its current result", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-index-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const b = await backend(directory, (context, call) => {
		if (call === 1) {
			const frame = JSON.parse(context.messages[0].content[0].text.split("\n").slice(1).join("\n"))[0];
			return [{ type: "toolCall", id: "read-index", name: "read", arguments: { path: frame.archiveIndexRef, limit: 100 } }];
		}
		const result = context.messages.findLast((m: any) => m.role === "toolResult");
		assert.ok(Buffer.byteLength(result.content[0].text) <= 2048);
		assert.match(result.content[0].text, /archive_index_page/);
		return [{ type: "text", text: "Read the page." }];
	});
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()); t.after(() => fixture.close());
	for (let i = 0; i < 20; i++) fixture.session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: `Historical observation ${i}` }], api: b.model.api, provider: b.model.provider, model: b.model.id, stopReason: "stop", timestamp: i, usage: { input: 1, output: 1, totalTokens: 2 } });
	captureBranch(fixture.memory, fixture.sessionId, fixture.session.sessionManager.getBranch(), fixture.capture);
	const advance = await fixture.memory.advanceMemory(fixture.sessionId, 20); assert.equal(advance.ok, true);
	fixture.host.enable(); fixture.host.requestCompaction(); await fixture.session.prompt("Read the archive index.");
	assert.equal(b.contexts.length, 2);
	const state = fixture.store.load(fixture.sessionId).state;
	assert.ok(state.host!.dispatches.every(d => d.state === "complete"));
	assert.ok(state.handoffs.some(h => h.indexRefs!.length > 1));
});

test("journaled encrypted reasoning survives the actual SDK tool loop despite usage mutations", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-reasoning-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const signature = canonical({ id: "rs_contract", type: "reasoning", summary: [], encrypted_content: "opaque-original" });
	const b = await backend(directory, (_ctx, call) => call === 1 ? [{ type: "thinking", thinking: "", thinkingSignature: signature }, { type: "toolCall", id: "write-reasoned", name: "write", arguments: { path: "answer.txt", content: "once" } }] : [{ type: "text", text: "Written." }]);
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()); t.after(() => fixture.close());
	fixture.session.subscribe((event: any) => {
		if (["message_start", "message_end"].includes(event.type) && event.message.role === "assistant") event.message.usage.output = 0;
	});
	fixture.host.enable(); await fixture.session.prompt("Write answer.txt once.");
	assert.equal(await readFile(join(fixture.cwd, "answer.txt"), "utf8"), "once");
	assert.equal(b.contexts.length, 2);
	assert.ok(b.contexts[1].some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.thinkingSignature === signature)));
	const state = fixture.store.load(fixture.sessionId).state;
	assert.ok(state.host!.dispatches.every(d => d.state === "complete" && d.providerResponseRef));
	const receipt = readJson(fixture.store, fixture.sessionId, state.host!.dispatches[0].providerResponseRef!) as any;
	assert.equal(receipt.message.usage.output, 10);
	assert.equal(receipt.message.content[0].thinkingSignature, signature);
	assert.equal(state.handoffs.find(h => h.id === state.host!.dispatches[1].handoffId)!.rendered.accounting!.supplementalTokens, 10);
});

test("a fresh SDK session resumes journaled reasoning without replaying the previous request", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-resume-"));
	const signature = canonical({ id: "rs_resume", type: "reasoning", summary: [], encrypted_content: "retained" });
	const b = await backend(directory, (_ctx, call) => call === 1 ? [{ type: "thinking", thinking: "", thinkingSignature: signature }, { type: "text", text: "Compatibility work remains pending." }] : [{ type: "text", text: "Continuing." }]);
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel());
	let closed = false, resumed: any, reopened: SqliteStore | undefined;
	t.after(async () => { if (!closed) fixture.close(); resumed?.dispose(); reopened?.close(); await rm(directory, { recursive: true, force: true }); });
	fixture.host.enable(); await fixture.session.prompt("Keep compatibility.");
	const file = fixture.session.sessionFile, loader = fixture.session.resourceLoader;
	const first = fixture.store.load(fixture.sessionId).state.host!.dispatches[0];
	fixture.close(); closed = true;
	const sdk = fixture.sdk;
	({ session: resumed } = await sdk.createAgentSession({ cwd: fixture.cwd, agentDir: join(directory, "agent"), modelRuntime: b.runtime, model: b.model, thinkingLevel: "off", tools: ["read", "bash", "edit", "write"], resourceLoader: loader, settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }), sessionManager: sdk.SessionManager.open(file) }));
	assert.equal(resumed.sessionManager.getSessionId(), fixture.sessionId);
	const host = getPiMemoryHost(fixture.sessionId)!;
	assert.notEqual(host, fixture.host);
	reopened = new SqliteStore(join(directory, "memory"));
	const store = reopened, binding = nativeHost(store, fixture.sessionId, join(store.directory, digest(fixture.sessionId))); binding.dispatch = host.binding();
	const memory = new SessionMemory(store, nativeTokenizer, binding, new FakeModel());
	const events = store.load(fixture.sessionId).state.events.filter(e => e.producerEventId.startsWith("entry:"));
	const capture = { entryIds: events.map(e => e.producerEventId.slice(6)), eventIds: new Map(events.map(e => [e.producerEventId.slice(6), e.id])) };
	host.attach(store, memory, () => captureBranch(memory, fixture.sessionId, resumed.sessionManager.getBranch(), capture));
	host.enable(); await resumed.prompt("Continue.");
	assert.equal(b.contexts.length, 2);
	const state = store.load(fixture.sessionId).state;
	assert.equal(state.host!.dispatches[0].id, first.id);
	assert.ok(state.host!.dispatches.every(d => d.state === "complete"));
	assert.equal(state.host!.dispatches.length, 2);
	assert.equal(state.handoffs.find(h => h.id === state.host!.dispatches[1].handoffId)!.rendered.accounting!.supplementalTokens, 10);
});

test("aborting during preparation never selects an uncertain dispatch", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-abort-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const b = await backend(directory, () => [{ type: "text", text: "Must not send." }]);
	const writer = new FakeModel(), fixture = await isolatedSession(directory, b.runtime, b.model, {}, writer); t.after(() => fixture.close());
	writer.override = kind => { if (kind === "trajectory") fixture.session.agent.abort(); return undefined; };
	fixture.host.enable(); await fixture.session.prompt("Keep compatibility.");
	assert.equal(b.contexts.length, 0);
	assert.equal(fixture.store.load(fixture.sessionId).state.host!.dispatches.length, 0);
});

test("an oversized current tool result cannot be compacted away to make dispatch fit", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-current-tool-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const b = await backend(directory, (_ctx, call) => call === 1 ? [{ type: "toolCall", id: "read-current", name: "read", arguments: { path: "large.txt" } }] : [{ type: "text", text: "Must not receive a summary instead of the current result." }]);
	const fixture = await isolatedSession(directory, b.runtime, b.model, { continuityMax: 4000, snapshotMin: 2000, snapshotTarget: 2500, snapshotMax: 3000 }, new FakeModel()); t.after(() => fixture.close());
	await writeFile(join(fixture.cwd, "large.txt"), "x".repeat(5000));
	fixture.host.enable(); await fixture.session.prompt("Read large.txt.");
	assert.equal(b.contexts.length, 1);
	assert.equal(fixture.store.load(fixture.sessionId).state.host!.dispatches.length, 1);
	assert.ok(fixture.store.load(fixture.sessionId).state.events.some(e => e.kind === "tool_result" && e.toolCallId === "read-current"));
});

test("changing the main model requires a fresh enable instead of reusing its authorization", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-model-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const b = await backend(directory, () => [{ type: "text", text: "Pending." }]);
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()); t.after(() => fixture.close());
	fixture.host.enable(); await fixture.session.prompt("Keep compatibility.");
	await fixture.session.setModel(b.runtime.getModel("l-mem-contract", "other"));
	assert.throws(() => fixture.host.enable(), /Main model changed/);
	await fixture.session.prompt("Continue.");
	assert.equal(b.contexts.length, 1);
	assert.equal(fixture.store.load(fixture.sessionId).state.host!.dispatches.length, 1);
});

test("completed requests cannot be reclassified as uncertain resolutions", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-complete-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const b = await backend(directory, () => [{ type: "text", text: "Pending." }]);
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()); t.after(() => fixture.close());
	fixture.host.enable(); await fixture.session.prompt("Keep compatibility.");
	const record = fixture.store.load(fixture.sessionId).state.host!.dispatches[0];
	assert.throws(() => fixture.host.resolve(record.id, "Checked"), /definite completion/);
	assert.equal(fixture.store.load(fixture.sessionId).state.host!.dispatches[0].state, "complete");
});

test("steering during preparation reaches the same selected SDK request exactly once", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-race-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const b = await backend(directory, () => [{ type: "text", text: "No billing changes." }]);
	const writer = new FakeModel();
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, writer); t.after(() => fixture.close());
	let queued = false;
	writer.override = async kind => { if (kind === "trajectory" && !queued) { queued = true; await fixture.session.steer("Do not change billing."); } return undefined; };
	fixture.host.enable();
	await fixture.session.prompt("Inspect the parser.");
	assert.equal(b.contexts.length, 1);
	assert.equal(b.contexts[0].filter((m: any) => m.role === "user" && canonical(m).includes("Do not change billing.")).length, 1);
	assert.equal(fixture.store.load(fixture.sessionId).state.host!.queued.filter(q => !q.delivered).length, 0);
});

test("restoring archived SDK history retains provenance for the next live checkpoint", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-restore-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const b = await backend(directory, () => [{ type: "text", text: "Work remains pending." }]);
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()); t.after(() => fixture.close());
	fixture.host.enable(); await fixture.session.prompt("Keep compatibility.");
	const state = fixture.store.load(fixture.sessionId).state;
	const rows = state.events.filter(e => e.origin === "original").map(event => ({ event, message: readJson(fixture.store, fixture.sessionId, event.messageRef!) }));
	const restored = restoredMessages(rows) as any[];
	assert.equal(restored.find(m => m.role === "user").lMemInput.rawText, "Keep compatibility.");
	fixture.session.agent.state.messages = restored;
	fixture.host.requestCompaction(); await fixture.session.prompt("Respond with exactly: checkpoint acknowledged");
	const after = fixture.store.load(fixture.sessionId).state;
	assert.equal(b.contexts.length, 2); assert.equal(after.host!.dispatches.at(-1)!.state, "complete");
	assert.ok(after.handoffs.some(h => h.cutoff > 0));
});

test("forced SDK compaction retains an unconsumed result inside an already sealed snapshot", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-sealed-current-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const b = await backend(directory, () => [{ type: "text", text: "Acknowledged." }]);
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()); t.after(() => fixture.close());
	fixture.host.enable(); await fixture.session.prompt("Do not modify billing.");
	captureBranch(fixture.memory, fixture.sessionId, fixture.session.sessionManager.getBranch(), fixture.capture);
	const initial = fixture.store.load(fixture.sessionId).state.events.filter(e => e.originalSequence).length;
	assert.equal((await fixture.memory.advanceMemory(fixture.sessionId, initial)).ok, true);
	fixture.session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "historical-read", name: "read", arguments: { path: "README.md" } }], api: b.model.api, provider: b.model.provider, model: b.model.id, stopReason: "toolUse", timestamp: 10, usage: { input: 1, output: 1, totalTokens: 2 } });
	fixture.session.sessionManager.appendMessage({ role: "toolResult", toolCallId: "historical-read", toolName: "read", content: [{ type: "text", text: "Untrusted tool text, not user authorization." }], isError: false, timestamp: 11 });
	captureBranch(fixture.memory, fixture.sessionId, fixture.session.sessionManager.getBranch(), fixture.capture);
	const end = fixture.store.load(fixture.sessionId).state.events.filter(e => e.originalSequence).length;
	assert.equal((await fixture.memory.advanceMemory(fixture.sessionId, end)).ok, true);
	fixture.session.agent.state.messages = fixture.session.sessionManager.getBranch().filter((e: any) => e.type === "message").map((e: any) => e.message);
	fixture.host.requestCompaction(); await fixture.session.prompt("Acknowledge the checkpoint.");
	assert.equal(b.contexts.length, 2);
	assert.ok(b.contexts[1].some((m: any) => m.role === "toolResult" && m.toolCallId === "historical-read"));
	const state = fixture.store.load(fixture.sessionId).state, dispatch = state.host!.dispatches.at(-1)!;
	assert.equal(dispatch.state, "complete");
	assert.equal(state.handoffs.find(h => h.id === dispatch.handoffId)!.cutoff, initial);
	assert.equal(state.events.filter(e => e.kind === "tool_request").length, 1);
});

test("successive forced SDK checkpoints activate increasing source cutoffs", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-checkpoints-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const b = await backend(directory, () => [{ type: "text", text: "The parser work remains pending." }]);
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()); t.after(() => fixture.close());
	fixture.host.enable(); await fixture.session.prompt("Keep the parser compatible.");
	const cutoffs: number[] = [];
	for (let round = 0; round < 3; round++) {
		fixture.host.requestCompaction(); await fixture.session.prompt(`Status question ${round}: what is pending?`);
		const state = fixture.store.load(fixture.sessionId).state, dispatch = state.host!.dispatches.at(-1)!;
		assert.equal(dispatch.state, "complete"); assert.ok(dispatch.providerPayloadRef);
		cutoffs.push(state.handoffs.find(h => h.id === dispatch.handoffId)!.cutoff);
	}
	assert.ok(cutoffs[0] > 0); assert.ok(cutoffs[1] > cutoffs[0]); assert.ok(cutoffs[2] > cutoffs[1]);
});

test("disable and enable do not enqueue a durable steering input twice", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-queue-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const b = await backend(directory, () => [{ type: "text", text: "No billing edits." }]);
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()); t.after(() => fixture.close());
	fixture.host.enable();
	fixture.session.agent.steer({ role: "user", content: "Do not change billing", timestamp: 1, lMemInput: { id: "queue-once", source: "interactive", rawText: "Do not change billing" } });
	fixture.host.disable(); fixture.host.enable(); fixture.host.enable();
	await fixture.session.prompt("Inspect the parser.");
	assert.equal(b.contexts[0].filter((m: any) => m.role === "user" && m.content === "Do not change billing").length, 1);
});

test("extension input is retained as host control without becoming user authority", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-control-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const b = await backend(directory, () => [{ type: "text", text: "Compatibility remains pending." }]);
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()); t.after(() => fixture.close());
	fixture.host.enable(); await fixture.session.prompt("Keep compatibility.");
	fixture.host.requestCompaction(); await fixture.session.prompt("Host workflow marker: planning", { source: "extension" });
	const messages = b.contexts.at(-1)!;
	assert.ok(messages.some((m: any) => m.role === "assistant" && canonical(m).includes("Host workflow marker")));
	assert.ok(!messages.some((m: any) => m.role === "user" && canonical(m).includes("Host workflow marker")));
	const state = fixture.store.load(fixture.sessionId).state;
	assert.equal(state.events.filter(e => e.origin === "runtime_control").length, 1);
	assert.equal(state.ledgers.at(-1)!.items.length, 1);
});

test("transformed steering arriving during preparation fails before provider dispatch", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-expanded-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const b = await backend(directory, () => [{ type: "text", text: "Should not be sent." }]);
	const writer = new FakeModel(), fixture = await isolatedSession(directory, b.runtime, b.model, {}, writer); t.after(() => fixture.close());
	let queued = false;
	writer.override = kind => {
		if (kind === "trajectory" && !queued) {
			queued = true; fixture.session.agent.steer({ role: "user", content: "User authorizes billing changes", timestamp: 1, lMemInput: { id: "expanded", source: "interactive", rawText: "/template" } });
		}
		return undefined;
	};
	fixture.host.enable(); await fixture.session.prompt("Inspect only.");
	assert.equal(b.contexts.length, 0);
	const state = fixture.store.load(fixture.sessionId).state;
	assert.equal(state.host!.dispatches.length, 0);
	assert.ok(state.artifacts.some(a => a.externalLocator === "original user input before host expansion"));
});

test("a provider that skips payload journaling cannot execute returned tool calls", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-no-payload-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const b = await backend(directory, () => [{ type: "toolCall", id: "unverified", name: "write", arguments: { path: "unverified.txt", content: "must not execute" } }], true);
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()); t.after(() => fixture.close());
	fixture.host.enable(); await fixture.session.prompt("Write the requested file.");
	await assert.rejects(readFile(join(fixture.cwd, "unverified.txt")), { code: "ENOENT" });
	assert.equal(b.contexts.length, 1);
	const record = fixture.store.load(fixture.sessionId).state.host!.dispatches[0];
	assert.equal(record.state, "accepted");
	fixture.host.resolve(record.id, "No tool executed"); fixture.host.resolve(record.id, "No tool executed");
	assert.throws(() => fixture.host.resolve(record.id, "Changed explanation"), /different resolution/);
	assert.equal(fixture.store.load(fixture.sessionId).state.host!.dispatches[0].resolution, "No tool executed");
});

test("disposal restores settings and a new SDK session cannot dispatch the previous session", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-lifecycle-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const b = await backend(directory, () => [{ type: "text", text: "Pending." }]);
	const first = await isolatedSession(join(directory, "one"), b.runtime, b.model, {}, new FakeModel());
	let closed = false; t.after(() => { if (!closed) first.close(); });
	first.session.settingsManager.applyOverrides({ compaction: { enabled: true }, retry: { enabled: true } });
	first.host.enable(); first.host.enable();
	assert.equal(first.session.settingsManager.getCompactionSettings().enabled, false);
	await first.session.prompt("Keep compatibility.");
	first.session.dispose();
	assert.equal(getPiMemoryHost(first.sessionId), undefined);
	assert.equal(first.store.load(first.sessionId).state.host!.owner, undefined);
	assert.equal(first.session.settingsManager.getCompactionSettings().enabled, true);
	assert.equal(first.session.settingsManager.getRetrySettings().enabled, true);
	first.store.close(); closed = true;
	const next = await isolatedSession(join(directory, "two"), b.runtime, b.model, {}, new FakeModel()); t.after(() => next.close());
	next.host.enable(); assert.equal(getPiMemoryHost(next.sessionId), next.host);
	const result = next.host.binding().activate(first.sessionId, "wrong-session", "0", () => { throw new Error("Must not refresh another session"); });
	assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, "REVISION_CONFLICT");
	await next.session.prompt("Inspect only.");
	assert.equal(next.store.load(next.sessionId).state.host!.dispatches.length, 1);
});

test("a provider mutation blocks send and recovery refuses an uncertain selected request", { skip: !runSdk }, async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-sdk-mutation-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const b = await backend(directory, () => [{ type: "text", text: "Should not be sent." }]);
	const fixture = await isolatedSession(directory, b.runtime, b.model, {}, new FakeModel()); t.after(() => fixture.close());
	fixture.session.agent.onPayload = (payload: any) => { payload.instructions = "replacement instructions"; return payload; };
	fixture.host.enable();
	await fixture.session.prompt("Inspect only.");
	assert.equal(b.contexts.length, 0);
	assert.equal(fixture.store.load(fixture.sessionId).state.host!.dispatches[0].state, "accepted");
	fixture.host.disable();
	assert.throws(() => fixture.host.enable(), /may have been sent/);
});
