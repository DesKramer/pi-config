import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { SessionMemory } from "../extensions/l-mem/memory.ts";
import { SqliteStore, type StorageFaultPoint } from "../extensions/l-mem/storage.ts";
import { FakeHost, FakeModel, event, testTokenizer, unwrap } from "../extensions/l-mem/testing.ts";

for (const stage of ["payload_written", "payload_synced", "payload_linked", "directory_synced", "before_manifest_commit", "after_manifest_commit"] satisfies StorageFaultPoint[]) {
	test(`recording recovers at ${stage} without a partially recorded event`, async t => {
		const directory = await mkdtemp(join(tmpdir(), "l-mem-crash-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		let armed = true;
		let store = new SqliteStore(directory, point => { if (armed && point === stage) { armed = false; throw new Error(`injected crash: ${stage}`); } });
		let memory = new SessionMemory(store, testTokenizer, new FakeHost(), new FakeModel());
		assert.equal(memory.recordEvent("session", "producer", event("Original immutable request")).ok, false);
		store.close(); store = new SqliteStore(directory); t.after(() => store.close());
		assert.equal(store.load("session").state.events.length, stage === "after_manifest_commit" ? 1 : 0);
		memory = new SessionMemory(store, testTokenizer, new FakeHost(), new FakeModel());
		const recovered = unwrap(memory.recordEvent("session", "producer", event("Original immutable request")));
		assert.equal(recovered.originalSequence, 1);
		assert.equal(store.load("session").state.events.length, 1);
		assert.equal(Buffer.from(store.read("session", recovered.payloadRef)).toString("utf8"), "Original immutable request");
		assert.equal(unwrap(memory.inspect("session")).validatedWatermark, 0);
	});
}

test("independent SQLite connections cannot overwrite an incompatible manifest revision", async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-cas-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const first = new SqliteStore(directory), second = new SqliteStore(directory);
	t.after(() => { first.close(); second.close(); });
	const old = second.load("s");
	const a = new SessionMemory(first, testTokenizer, new FakeHost(), new FakeModel());
	const b = new SessionMemory(second, testTokenizer, new FakeHost(), new FakeModel());
	unwrap(a.recordEvent("s", "a", event("First")));
	assert.equal(second.compareAndSwap("s", old.revision, old.state), false);
	unwrap(b.recordEvent("s", "b", event("Second")));
	assert.deepEqual(first.load("s").state.events.map(e => e.originalSequence), [1, 2]);
});
