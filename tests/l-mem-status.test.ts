import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionMemory, formatStatus } from "../extensions/l-mem/memory.ts";
import { FakeStore, SqliteStore, canonical, update } from "../extensions/l-mem/storage.ts";
import { FakeHost, FakeModel, event, testTokenizer, unwrap } from "../extensions/l-mem/testing.ts";
import { nativeTokenizer } from "../extensions/l-mem/native-context.ts";
import lMem from "../extensions/l-mem/index.ts";

const config = { snapshotMin: 20, snapshotTarget: 30, snapshotMax: 40 };
function setup() {
	const store = new FakeStore(), model = new FakeModel(), host = new FakeHost();
	return { store, model, host, memory: new SessionMemory(store, testTokenizer, host, model, config) };
}

test("status is read-only and shows progress using only unsealed original events", () => {
	const { memory, store, model, host } = setup();
	unwrap(memory.recordEvent("s", "user", event("x".repeat(22))));
	unwrap(memory.recordEvent("s", "derived", event("x".repeat(1000), "agent_message", { origin: "derived_memory" })));
	unwrap(memory.recordEvent("s", "control", event("x".repeat(1000), "agent_message", { origin: "runtime_control", authority: "host" })));
	const before = canonical(store.load("s"));
	const status = memory.inspect("s"), value = unwrap(status);
	assert.equal(value.snapshotProgress.bufferedTokens, 22);
	assert.equal(value.snapshotProgress.bufferedEvents, 1);
	assert.equal(value.snapshotProgress.tokensToTarget, 8);
	assert.equal(value.snapshotProgress.percent, 73);
	assert.match(formatStatus(status), /22 \/ 30 tokens, 73%/);
	assert.match(formatStatus(status), /8 more tokens/);
	assert.equal(canonical(store.load("s")), before);
	assert.equal(model.calls.length, 0); assert.equal(host.sendCount, 0);
	unwrap(memory.recordEvent("s", "later", event("x".repeat(8))));
	assert.equal(unwrap(memory.inspect("s")).snapshotProgress.thresholdReached, true);
	assert.match(formatStatus(memory.inspect("s")), /target reached; awaiting/);
	assert.equal(store.load("s").state.snapshots.length, 0);
});

test("next snapshot progress resets on sealing, not on block publication", async () => {
	const store = new FakeStore(), memory = new SessionMemory(store, testTokenizer, new FakeHost(), undefined, config);
	unwrap(memory.recordEvent("s", "first", event("x".repeat(30))));
	assert.equal((await memory.advanceMemory("s")).ok, false);
	unwrap(memory.recordEvent("s", "next", event("x".repeat(7))));
	const status = memory.inspect("s"), value = unwrap(status);
	assert.equal(value.uncoveredTokens, 37);
	assert.equal(value.snapshotProgress.bufferedTokens, 7);
	assert.equal(value.snapshotProgress.tokensToTarget, 23);
	assert.equal(value.memoryBlocks[0].state, "pending");
	assert.match(formatStatus(status), /0 published, 1 awaiting publication/);
	assert.match(formatStatus(status), /Block generation unavailable: no memory model binding/);
});

test("status recounts buffered input when the tokenizer changes and labels the bound", () => {
	const { store, memory } = setup();
	unwrap(memory.recordEvent("s", "unicode", event("🙂🙂🙂")));
	const native = new SessionMemory(store, nativeTokenizer, new FakeHost(), undefined, config);
	const before = canonical(store.load("s")), status = native.inspect("s");
	assert.equal(unwrap(status).snapshotProgress.bufferedTokens, 12);
	assert.match(formatStatus(status), /12 \/ 30 counted units/);
	assert.match(formatStatus(status), /conservative bound, not measured provider tokens/);
	assert.equal(canonical(store.load("s")), before);
});

test("published block status uses the current regenerated version without double counting", async () => {
	let now = 10000;
	const store = new FakeStore(), memory = new SessionMemory(store, testTokenizer, new FakeHost(), new FakeModel(), config, () => now);
	unwrap(memory.recordEvent("s", "user", event("Keep compatibility")));
	unwrap(await memory.advanceMemory("s", 1));
	const first = unwrap(memory.inspect("s")).memoryBlocks[0];
	assert.equal(first.state, "published"); assert.equal(first.versions, 1);
	now += 1000;
	unwrap(await memory.advanceMemory("s", { kind: "regenerate_block", blockId: first.blockId! }));
	now += 60000;
	const status = memory.inspect("s"), value = unwrap(status);
	assert.equal(value.memoryBlocks.length, 1); assert.equal(value.retainedBlockVersions, 2);
	assert.equal(value.memoryBlocks[0].versions, 2);
	assert.notEqual(value.memoryBlocks[0].blockId, first.blockId);
	assert.equal(value.snapshotProgress.bufferedTokens, 0);
	assert.match(formatStatus(status), /1 published, 0 awaiting publication. 2 stored block versions/);
	assert.match(formatStatus(status), /v2.*generated 1m ago/);
	assert.ok(!formatStatus(status).includes(first.blockId!));
});

test("status returns while a writer is running and shows publication after it finishes", async t => {
	const { memory, model, store } = setup();
	let ready!: () => void, release!: () => void;
	const started = new Promise<void>(resolve => { ready = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
	model.override = async kind => { if (kind === "writer") { ready(); await resume; } return undefined; };
	unwrap(memory.recordEvent("s", "user", event("Keep compatibility")));
	const work = memory.advanceMemory("s", 1);
	t.after(async () => { release(); await work; });
	await started;
	const before = canonical(store.load("s")), status = memory.inspect("s");
	assert.match(formatStatus(status), /Jobs: 1 running/);
	assert.match(formatStatus(status), /writer running, 0 finished attempts/);
	assert.match(formatStatus(status), /Next block: snapshot #1/);
	assert.equal(canonical(store.load("s")), before);
	release(); unwrap(await work);
	assert.match(formatStatus(memory.inspect("s")), /1 published, 0 awaiting publication/);
	assert.match(formatStatus(memory.inspect("s")), /Jobs: 0 running/);
});

test("status exposes invalid jobs and does not present an expired lease as running", async () => {
	const store = new FakeStore(), model = new FakeModel(); model.override = () => ({});
	const memory = new SessionMemory(store, testTokenizer, new FakeHost(), model, { ...config, repairs: 0 });
	unwrap(memory.recordEvent("s", "user", event("Keep compatibility")));
	assert.equal((await memory.advanceMemory("s", 1)).ok, false);
	assert.match(formatStatus(memory.inspect("s")), /1 invalid/);
	assert.match(formatStatus(memory.inspect("s")), /Last recorded failure: WRITER_INVALID/);
	update(store, "s", state => { state.jobs[0].state = "running"; state.jobs[0].leaseUntil = 0; });
	assert.match(formatStatus(memory.inspect("s")), /Jobs: 0 running, 1 expired leases/);
	assert.match(formatStatus(memory.inspect("s")), /not confirmed running/);
});

test("status bounds the recent block list and keeps multiline model titles out of its layout", async () => {
	const { memory, model } = setup();
	model.override = kind => kind === "block" ? { title: "\x1b[31mTitle\n" + "long title ".repeat(30), claimIds: [] } : undefined;
	for (let i = 1; i <= 8; i++) {
		unwrap(memory.recordEvent("s", String(i), event("Observation", "agent_message")));
		unwrap(await memory.advanceMemory("s", i));
	}
	const text = formatStatus(memory.inspect("s"));
	assert.match(text, /Latest 5 of 8 snapshots/);
	assert.equal(text.match(/^  #\d+ published/gm)!.length, 5);
	assert.match(text, /#8 published/); assert.doesNotMatch(text, /#1 published/);
	assert.doesNotMatch(text, /\x1b/); assert.ok(text.length < 4500);
});

test("status preserves inspection failures instead of reporting empty healthy memory", () => {
	assert.equal(formatStatus({ ok: false, code: "STORAGE_ERROR", message: "Manifest corrupt", retryable: false }), "STORAGE_ERROR: Manifest corrupt");
});

function commandFixture(mode = "off") {
	const handlers = new Map<string, Function>(), commands = new Map<string, any>(), notices: string[] = [];
	lMem({ registerFlag() {}, getFlag: () => mode, getActiveTools: () => ["read"], on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (name: string, cmd: any) => commands.set(name, cmd) } as any);
	return { handlers, notices, command: commands.get("l-mem"), ui: { notify: (text: string) => notices.push(text), setStatus() {} } };
}

test("status while off does not initialize archives, and failed startup remains visibly paused", async () => {
	const f = commandFixture();
	await f.command.handler("status", { hasUI: true, ui: f.ui });
	assert.match(f.notices.at(-1)!, /Mode: off/);
	assert.match(f.notices.at(-1)!, /Archive not open; block status unavailable/);
	const ctx = { hasUI: true, ui: f.ui, sessionManager: { getSessionFile: () => undefined } };
	await f.command.handler("shadow", ctx);
	await f.command.handler("status", ctx);
	assert.match(f.notices.at(-1)!, /Mode: shadow; recording only, live replacement off/);
	assert.match(f.notices.at(-1)!, /Capture: paused/);
	assert.match(f.notices.at(-1)!, /requires a durable session/);
});

test("rejected live enable and startup never fall back to paid shadow capture", async () => {
	const previous = process.env.L_MEM_ACCEPTANCE_REPORT; delete process.env.L_MEM_ACCEPTANCE_REPORT;
	try {
		for (const mode of ["off", "enable"]) {
			const f = commandFixture(mode);
			const ctx = { hasUI: true, ui: f.ui, model: { provider: "fixture", id: "fixture" }, sessionManager: { getSessionFile: () => { throw new Error("must not open an archive"); } } };
			if (mode === "off") await f.command.handler("enable", ctx); else await f.handlers.get("session_start")!({}, ctx);
			assert.match(f.notices.at(-1)!, /L_MEM_ACCEPTANCE_REPORT/);
			await f.command.handler("status", ctx);
			assert.match(f.notices.at(-1)!, /Mode: off/);
			assert.match(f.notices.at(-1)!, /Capture: off/);
			assert.match(f.notices.at(-1)!, /Archive not open/);
		}
	} finally { if (previous === undefined) delete process.env.L_MEM_ACCEPTANCE_REPORT; else process.env.L_MEM_ACCEPTANCE_REPORT = previous; }
});

test("shadow status reads the journal without starting another pass or changing session messages", async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-status-")), f = commandFixture();
	const branch = [{ type: "message", id: "u", timestamp: "2026-01-01", message: { role: "user", content: "Keep compatibility", timestamp: 1 } }];
	const ctx = { hasUI: true, ui: f.ui, modelRegistry: {}, sessionManager: { getSessionFile: () => join(directory, "session.jsonl"), getSessionId: () => "s", getBranch: () => branch } };
	let probe: SqliteStore | undefined;
	t.after(async () => { await f.command.handler("off", ctx); probe?.close(); await rm(directory, { recursive: true, force: true }); });
	await f.command.handler("shadow", ctx); await new Promise(resolve => setImmediate(resolve));
	probe = new SqliteStore(join(directory, "l-mem"));
	const before = canonical(probe.load("s")), messages = canonical(branch);
	await f.command.handler("status", ctx); await f.command.handler("status", ctx);
	assert.match(f.notices.at(-1)!, /18 \/ 12,500 counted units/);
	assert.match(f.notices.at(-1)!, /Background pass: idle/);
	assert.match(f.notices.at(-1)!, /Block generation unavailable/);
	assert.equal(canonical(probe.load("s")), before); assert.equal(canonical(branch), messages);
});
