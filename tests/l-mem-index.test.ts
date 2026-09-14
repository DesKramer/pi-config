import test from "node:test";
import assert from "node:assert/strict";
import { archiveIndex } from "../extensions/l-mem/archive-index.ts";
import { FakeStore, readJson } from "../extensions/l-mem/storage.ts";
import type { Json } from "../extensions/l-mem/contracts.ts";

test("archive index pages preserve every row, bound default reads and retain oversized records", () => {
	const store = new FakeStore();
	const entries = Array.from({ length: 60 }, (_, i) => ({ kind: "event", eventId: `e_${i}`, text: i === 30 ? "large".repeat(3000) : "normal" })) as Json[];
	const result = archiveIndex(store, "s", entries, 512), rows: Json[] = [];
	const seen = new Set<string>();
	const walk = (ref: string) => {
		let next: string | null = ref;
		while (next) {
			assert.equal(seen.has(next), false); seen.add(next);
			assert.ok(result.refs.includes(next));
			const bytes = store.read("s", next); assert.ok(bytes.length <= 512);
			const [header, ...page] = Buffer.from(bytes).toString("utf8").split("\n").map(line => JSON.parse(line));
			for (const row of page) {
				if (row.kind === "index_section") walk(row.ref);
				else if (row.kind === "oversized_index_entry") { assert.ok(result.refs.includes(row.ref)); assert.ok(row.byteLength > 512); rows.push(readJson(store, "s", row.ref)); }
				else rows.push(row);
			}
			next = header.nextRef;
		}
	};
	walk(result.rootRef);
	assert.ok(seen.size > 1);
	assert.match(Buffer.from(store.read("s", result.rootRef)).toString(), /index_section/);
	assert.deepEqual(rows, entries);
	assert.deepEqual(archiveIndex(store, "s", entries, 512), result);
	assert.throws(() => archiveIndex(store, "s", [], 1), /framing/);
});

test("typed index directory locates auxiliary captures without scanning private JSON", () => {
	const store = new FakeStore();
	const entries: Json[] = [{ kind: "block", blockId: "b1" }, { kind: "item", itemId: "i1" }, { kind: "artifact", artifactId: "a1", captureKind: "auxiliary_capture", ref: "full-log.txt" }, { kind: "event", eventId: "e1" }];
	const index = archiveIndex(store, "s", entries);
	const rows = (ref: string) => Buffer.from(store.read("s", ref)).toString().split("\n").slice(1).map(line => JSON.parse(line));
	const sections = rows(index.rootRef);
	assert.deepEqual(sections.map(s => s.entryKind), ["block", "item", "artifact", "event"]);
	const artifacts = sections.find(s => s.entryKind === "artifact");
	assert.equal(artifacts.kind, "index_section"); assert.equal(artifacts.entries, 1);
	assert.deepEqual(rows(artifacts.ref), [entries[2]]);
	for (const ref of index.refs) assert.ok(store.read("s", ref).length <= 2048);
});
