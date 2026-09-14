import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionMemory } from "../extensions/l-mem/memory.ts";
import { FakeHost, FakeModel, contextRequest, extractionFor, testTokenizer as characterTokenizer, event as sourceEvent, unwrap } from "../extensions/l-mem/testing.ts";
import { FakeStore, SqliteStore, canonical, hash, json, readJson, update, type StorageFaultPoint } from "../extensions/l-mem/storage.ts";
import { currentBlocks } from "../extensions/l-mem/derived.ts";
import { evidence, validatePage } from "../extensions/l-mem/validation.ts";
import type { DerivedUpdate, EvidenceRef, EventInput } from "../extensions/l-mem/contracts.ts";

function event(kind: EventInput["kind"], payload: string) { return sourceEvent(payload, kind); }
function setup() {
	const store = new FakeStore(), model = new FakeModel(), host = new FakeHost();
	const memory = new SessionMemory(store, characterTokenizer, host, model, { snapshotMin: 100, snapshotTarget: 150, snapshotMax: 200 });
	return { store, model, host, memory };
}
const request = { requestId: "prepare", contextRevision: "0", capacity: 100000, fixedTokens: 1000, outputReserve: 1000, safetyMargin: 1000, unactedUserEventIds: [] as string[], cutoff: 1 };

test("fitting exact tails retain validated coverage without forcing tiny snapshots", async () => {
	const { store, model, host } = setup();
	const memory = new SessionMemory(store, characterTokenizer, host, model, { tailPreferred: 1 });
	unwrap(memory.recordEvent("s", "u", sourceEvent("Keep compatibility")));
	unwrap(memory.recordEvent("s", "a", sourceEvent("Pending.", "agent_message")));
	const first = unwrap(await memory.prepareCompaction("s", contextRequest({ cutoff: 2 })));
	const jobs = model.calls.length, snapshots = store.load("s").state.snapshots.length;
	for (let i = 0; i < 5; i++) {
		const latest = unwrap(memory.recordEvent("s", `a:${i}`, sourceEvent(`Inspection ${i}`, "agent_message")));
		const next = unwrap(await memory.prepareCompaction("s", contextRequest({ requestId: `r:${i}` })));
		assert.equal(next.cutoff, first.cutoff); assert.ok(next.tailEventIds.includes(latest.id));
	}
	assert.equal(model.calls.length, jobs);
	assert.equal(store.load("s").state.snapshots.length, snapshots);
});

test("published coverage can dispatch while a newer snapshot writer is still running", async () => {
	const { store, model, memory } = setup();
	unwrap(memory.recordEvent("s", "u", sourceEvent("Keep compatibility")));
	unwrap(await memory.prepareCompaction("s", contextRequest({ cutoff: 1 })));
	let entered!: () => void, release!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; }), paused = new Promise<void>(resolve => { release = resolve; });
	model.override = async kind => { if (kind === "writer") { entered(); await paused; } return undefined; };
	const latest = unwrap(memory.recordEvent("s", "u2", sourceEvent("Keep the new condition. ".repeat(8))));
	const pending = memory.advanceMemory("s"); await started;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const prepared = await Promise.race([memory.prepareCompaction("s", contextRequest({ requestId: "during-writer", unactedUserEventIds: [latest.id] })), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Waited for the background writer")), 1000); })]);
		const handoff = unwrap(prepared);
		assert.equal(handoff.cutoff, 1); assert.ok(handoff.tailEventIds.includes(latest.id));
	} finally { clearTimeout(timer); release(); await pending; }
});

test("writer repairs timestamp-shaped positions before publication", async () => {
	const { store, memory, model } = setup();
	unwrap(memory.recordEvent("s", "u", sourceEvent("Explain the side question", "user_message", { timestamp: 51 })));
	let writes = 0;
	model.override = (kind, input) => {
		if (kind !== "writer") return undefined;
		assert.equal(input.source.newItemCreatedAt, 1); assert.equal(input.source.lastTransition, 1);
		const page = extractionFor(input); writes++;
		if (writes === 1) { page.mutations[0].item.createdAt = 51; page.mutations[0].item.lastTransition = 51; }
		if (writes === 2) page.mutations[0].item.createdAt = 51;
		return json(page);
	};
	unwrap(await memory.advanceMemory("s", 1));
	const state = store.load("s").state, job = state.jobs.find(j => j.kind === "writer")!;
	assert.equal(job.attempts.length, 3);
	assert.match(job.attempts[0].error!, /lastTransition must be 1.*originalSequence/);
	assert.match(job.attempts[1].error!, /createdAt must be 1.*originalSequence/);
	assert.equal(state.ledgers.at(-1)!.items[0].createdAt, 1);
	assert.equal(state.ledgers.at(-1)!.items[0].lastTransition, 1);
});

test("latest-cutoff preference uses an earlier sealed endpoint when current input crosses the newest snapshot", async () => {
	const { store, memory } = setup();
	for (let i = 1; i <= 2; i++) unwrap(memory.recordEvent("s", `e${i}`, sourceEvent(`Earlier observation ${i}`, "agent_message")));
	unwrap(await memory.advanceMemory("s", 2));
	let current!: ReturnType<typeof memory.recordEvent>;
	for (let i = 3; i <= 5; i++) current = memory.recordEvent("s", `e${i}`, sourceEvent(`Later observation ${i}`, "agent_message"));
	unwrap(await memory.advanceMemory("s", 5));
	const before = canonical(store.load("s").state.snapshots);
	const prepared = unwrap(await memory.prepareCompaction("s", contextRequest({ preferLatestCutoff: true, exactTailEventIds: [unwrap(current).id] })));
	assert.equal(prepared.cutoff, 2); assert.ok(prepared.tailEventIds.includes(unwrap(current).id));
	assert.equal(canonical(store.load("s").state.snapshots), before);
});

test("newly sealed interiors do not hide mandatory capacity failures", async () => {
	const { store, host, model } = setup();
	const memory = new SessionMemory(store, characterTokenizer, host, model, { continuityMax: 2500 });
	unwrap(memory.recordEvent("s", "u", sourceEvent("Preserve compatibility")));
	unwrap(await memory.advanceMemory("s", 1));
	for (let i = 2; i <= 3; i++) unwrap(memory.recordEvent("s", `e${i}`, sourceEvent(`Old observation ${i}`, "agent_message")));
	const current = unwrap(memory.recordEvent("s", "current", sourceEvent("x".repeat(7000), "agent_message")));
	const result = await memory.prepareCompaction("s", contextRequest({ preferLatestCutoff: true, exactTailEventIds: [current.id] }));
	assert.equal(result.ok, false);
	if (!result.ok) { assert.ok(["ACTIVE_STATE_TOO_LARGE", "CONTEXT_BUDGET_EXCEEDED"].includes(result.code)); assert.doesNotMatch(result.message, /split/); }
	assert.ok(store.load("s").state.snapshots.some(s => s.start === 2 && s.end === 3));
});

test("a small trajectory keeps the complete next action and all obligations in included continuations", async () => {
	const { store, host, model } = setup();
	const memory = new SessionMemory(store, characterTokenizer, host, model, { trajectoryMax: 1600 });
	const baseRender = host.render.bind(host);
	host.render = (input, tokenizer) => baseRender({ ...input, history: input.history.map((r: any) => r.block ? { ...r, hostFraming: "x".repeat(40000) } : r) }, tokenizer);
	model.override = (kind, input) => kind === "trajectory" ? json({ schemaVersion: 1, cutoff: input.cutoff, entries: input.items.map((i: any) => ({ itemId: i.id, category: "Remaining Work" })), nextAction: { text: "Inspect before editing. ".repeat(75), origin: "agent_proposal", itemIds: input.items.map((i: any) => i.id), evidenceBlockIds: input.blocks.map((b: any) => b.id), retrievalPrerequisites: ["Retain every compatibility and final-edit validation condition."] }, conflictIds: [], requiredBlockIds: [] }) : undefined;
	for (let i = 0; i < 12; i++) unwrap(memory.recordEvent("s", `u${i}`, sourceEvent(`Task ${i}: preserve compatibility and validate after the final edit.`)));
	const handoff = unwrap(await memory.prepareCompaction("s", contextRequest({ cutoff: 12 })));
	assert.equal(handoff.activeLocations.length, 12);
	assert.ok(handoff.rendered.counts.trajectory <= 1600); assert.ok(handoff.rendered.counts.total <= 35000);
	const next = (handoff.trajectory as any).nextAction;
	assert.equal(next.origin, "agent_proposal"); assert.match(next.location, /^current_state_continuation:/);
	const continuation = handoff.continuations[Number(next.location.split(":")[1])] as any;
	assert.equal(continuation.records[0].nextAction.itemIds.length, 12);
	assert.equal(continuation.records[0].nextAction.text, "Inspect before editing. ".repeat(75));
	assert.ok(continuation.records[0].nextAction.retrievalPrerequisites.some((p: string) => p.includes("using the archive access described in the history frame")));
	assert.ok(canonical(handoff.renderInput.history).includes("using the archive access described in the history frame"));
	for (const location of handoff.activeLocations) assert.ok(canonical(handoff.renderInput.history).includes(location.itemId));
	const excerpt = (handoff.continuations.flatMap((c: any) => c.records).find((r: any) => r.exactUserExcerpts) as any).exactUserExcerpts[0];
	assert.equal(Buffer.from(store.read("s", excerpt.originalRef)).toString(), excerpt.text);
});

test("current protocol input cannot be placed behind the handoff cutoff", async () => {
	const { memory } = setup();
	unwrap(memory.recordEvent("s", "u", sourceEvent("Keep compatibility")));
	const current = unwrap(memory.recordEvent("s", "r", sourceEvent("Current protocol result", "agent_message")));
	const refused = await memory.prepareCompaction("s", contextRequest({ cutoff: 2, exactTailEventIds: [current.id] }));
	assert.equal(refused.ok, false);
	const prepared = unwrap(await memory.prepareCompaction("s", contextRequest({ requestId: "legal", exactTailEventIds: [current.id] })));
	assert.ok(prepared.cutoff < current.originalSequence!); assert.ok(prepared.tailEventIds.includes(current.id));
});

test("a correction published after candidate selection still blocks an obsolete cutoff", async () => {
	const { store, memory, host } = setup();
	unwrap(memory.recordEvent("s", "u", sourceEvent("Keep compatibility")));
	unwrap(await memory.advanceMemory("s", 1));
	unwrap(memory.recordEvent("s", "u2", sourceEvent("Keep billing unchanged")));
	unwrap(await memory.advanceMemory("s", 2));
	const check = host.validateTail.bind(host); let changed = false;
	host.validateTail = (tail, support) => {
		if (!changed) { changed = true; update(store, "s", state => { state.minimumHandoffCutoff = 2; state.derivedRevision = (state.derivedRevision ?? 0) + 1; }); }
		return check(tail, support);
	};
	const prepared = await memory.prepareCompaction("s", contextRequest({ cutoff: 1 }));
	assert.equal(prepared.ok, false); if (!prepared.ok) assert.equal(prepared.code, "REVISION_CONFLICT");
});

test("host command/cwd/exit evidence supports scoped test observations, not generic completion", () => {
	const validate = (payload: unknown, status = "failed", authority = "host", category = "tested") => {
		const { store, memory } = setup(), text = typeof payload === "string" ? payload : canonical(payload);
		const source = unwrap(memory.recordEvent("s", "execution", sourceEvent(text, "operation_status", { authority: authority as any, operationStatus: status as any })));
		return validatePage({ schemaVersion: 1, complete: true, nextCursor: null, mutations: [], receipts: [], claims: [{ id: `${source.id}:claim:0`, text: "Command execution observed at its recorded scope; no feature acceptance claimed.", scope: "Command and cwd only", category, itemIds: [], entities: [], invalidatesIds: [], sourceRefs: [{ sessionId: "s", eventId: source.id, quote: text, observationScope: "Recorded execution" }] }] }, store.load("s").state, store, new Set([source.id]), new Set([source.id]), new Map());
	};
	const record = { tool: "bash", execution: { command: "npm test", cwd: "/fixture", exitCode: 1 } };
	assert.doesNotThrow(() => validate(record));
	assert.doesNotThrow(() => validate({ ...record, execution: { ...record.execution, exitCode: 0 } }, "completed"));
	for (const malformed of ["Completed", { tool: "bash" }, { tool: "read", execution: record.execution }, { tool: "bash", execution: { command: "npm test", exitCode: 1 } }, { tool: "bash", execution: { ...record.execution, exitCode: null } }]) assert.throws(() => validate(malformed), /lacks an observed result/);
	assert.throws(() => validate(record, "completed"), /lacks an observed result/);
	assert.throws(() => validate(record, "failed", "tool"), /lacks an observed result/);
	assert.throws(() => validate(record, "failed", "host", "completed"), /lacks an observed result/);
});

test("failed writer diagnostics survive later candidate capacity failures", async () => {
	const { store, host, model } = setup();
	const memory = new SessionMemory(store, characterTokenizer, host, model, { continuityMax: 3500, tailPreferred: 1 });
	unwrap(memory.recordEvent("s", "u", sourceEvent("Keep compatibility")));
	unwrap(memory.recordEvent("s", "log", sourceEvent("log ".repeat(1500), "agent_message")));
	model.override = kind => { if (kind === "writer") throw new Error("writer unavailable"); return undefined; };
	const result = await memory.prepareCompaction("s", contextRequest());
	assert.equal(result.ok, false); if (!result.ok) { assert.equal(result.code, "WRITER_INVALID"); assert.match(result.message, /writer unavailable/); }
});

test("exact quotes resolve literal Unicode without guessed offsets and remain valid when reread", () => {
	const { store, memory } = setup();
	const source = unwrap(memory.recordEvent("s", "u", event("user_message", "α Preserve José; α Preserve José")));
	const state = store.load("s").state;
	const ref: EvidenceRef = { sessionId: "s", eventId: source.id, quote: "José", observationScope: "Quoted name" };
	assert.throws(() => evidence(ref, state, store, new Set([source.id])), /ambiguous/);
	evidence(ref, state, store, new Set([source.id]), new Map([[source.id, { start: 0, end: 18 }]]));
	assert.equal(Buffer.from(store.read("s", source.payloadRef)).subarray(ref.span!.start, ref.span!.end).toString(), "José");
	assert.doesNotThrow(() => evidence(ref, state, store, new Set([source.id])));
	assert.throws(() => evidence({ ...ref, quote: "Josa" }, state, store, new Set([source.id])), /disagree/);
});

test("array repair errors identify the missing claim field", () => {
	const { store, memory } = setup();
	const source = unwrap(memory.recordEvent("s", "u", event("user_message", "Keep compatibility")));
	assert.throws(() => validatePage({ schemaVersion: 1, complete: true, nextCursor: null, mutations: [], receipts: [], claims: [{ id: `${source.id}:claim:0`, text: "Keep compatibility", scope: "Parser", category: "explicit_user", itemIds: [], entities: [], sourceRefs: [] }] }, store.load("s").state, store, new Set([source.id]), new Set([source.id]), new Map()), /Claim.invalidatesIds/);
});

test("batched extraction reviews every user and does not multiply source coverage", async () => {
	const { store, model, host } = setup(), memory = new SessionMemory(store, characterTokenizer, host, model, { writerBatchEvents: 8 });
	for (let i = 0; i < 4; i++) unwrap(memory.recordEvent("s", `u${i}`, event("user_message", `Keep obligation ${i}`)));
	unwrap(await memory.advanceMemory("s", 4));
	assert.equal(store.load("s").state.ledgers.at(-1)!.receipts.length, 4);
	assert.equal(model.calls.filter(c => c.kind === "writer").length, 1);
});

test("control-only arrivals invalidate reuse and refresh at activation without new source coverage", async () => {
	const { store, model, memory, host } = setup();
	unwrap(memory.recordEvent("s", "u", event("user_message", "Keep compatibility")));
	const req = contextRequest({ cutoff: 1 });
	const first = unwrap(await memory.prepareCompaction("s", req));
	const control = (text: string) => sourceEvent(text, "agent_message", { origin: "runtime_control", authority: "host" });
	const one = unwrap(memory.recordEvent("s", "control-1", control("Current workflow phase: inspect")));
	const second = unwrap(await memory.prepareCompaction("s", req));
	assert.notEqual(second.id, first.id); assert.deepEqual(second.controlEventIds, [one.id]);
	const calls = model.calls.length;
	host.beforeActivate = () => { unwrap(memory.recordEvent("s", "control-2", control("Do not treat a workflow message as user approval"))); };
	const activated = unwrap(memory.activateHandoff("s", second.id, req.contextRevision));
	const state = store.load("s").state, current = state.handoffs.find(h => h.id === activated.handoffId)!;
	assert.equal(current.watermark, 1); assert.equal(current.controlEventIds!.length, 2);
	assert.match(canonical(current.rendered.payload), /not user authorization/);
	assert.deepEqual(current.snapshotIds, first.snapshotIds); assert.equal(state.ledgers.at(-1)!.items.length, 1);
	assert.equal(model.calls.length, calls); assert.equal(host.sendCount, 1);
	assert.deepEqual(state.snapshots.flatMap(s => s.eventIds), [state.events[0].id]);
});

test("control-only overflow blocks activation rather than dropping the arrival", async () => {
	const { store, memory, host } = setup();
	unwrap(memory.recordEvent("s", "u", event("user_message", "Keep compatibility")));
	const req = contextRequest({ cutoff: 1 }), handoff = unwrap(await memory.prepareCompaction("s", req));
	host.beforeActivate = () => { unwrap(memory.recordEvent("s", "large-control", sourceEvent("X".repeat(36000), "agent_message", { origin: "runtime_control", authority: "host" }))); };
	const result = memory.activateHandoff("s", handoff.id, req.contextRevision);
	assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, "CONTEXT_BUDGET_EXCEEDED");
	assert.equal(host.sendCount, 0); assert.equal(store.load("s").state.events.length, 2);
});

test("a batch cannot backdate a transition using a later source in that batch", async () => {
	const store = new FakeStore(), model = new FakeModel();
	const memory = new SessionMemory(store, characterTokenizer, new FakeHost(), model);
	unwrap(memory.recordEvent("s", "u", event("user_message", "Keep compatibility")));
	const later = unwrap(memory.recordEvent("s", "a", event("agent_message", "Later evidence")));
	model.override = (kind, input) => {
		if (kind !== "writer") return;
		const page = extractionFor(input);
		page.mutations[0].item.sourceRefs.push({ sessionId: "s", eventId: later.id, observationScope: "later source", span: { start: 0, end: 5, encoding: "utf8" } });
		return json(page);
	};
	const result = await memory.advanceMemory("s", 2);
	assert.equal(result.ok, false); if (!result.ok) assert.match(result.message, /later original position/);
	assert.equal(store.load("s").state.ledgers.length, 0);
});

test("bounded writer reads retain earlier pages within the same job", async () => {
	const store = new FakeStore(), fake = new FakeModel(); let reads = 0, ref = "";
	const memory = new SessionMemory(store, characterTokenizer, new FakeHost(), { identity: fake.identity, async invoke(job) {
		if (job.kind === "writer") {
			const input = job.input as any;
			if (reads < 2) return json({ read: { ref, offset: reads++ * 5, limit: 5 } });
			assert.deepEqual(input.memoryReads.map((r: any) => r.text), ["ABCDE", "FGHIJ"]);
			assert.equal(input.memoryRead.nextOffset, 10);
		}
		return fake.invoke(job);
	} });
	ref = unwrap(memory.recordEvent("s", "u", event("user_message", "ABCDEFGHIJKLMN"))).payloadRef;
	unwrap(await memory.advanceMemory("s", 1));
	assert.equal(reads, 2); assert.equal(store.load("s").state.jobs.find(j => j.kind === "writer")!.attempts.length, 1);
});

test("regeneration versions the block without applying ledger mutations again", async () => {
	const { store, model, memory } = setup();
	unwrap(memory.recordEvent("s", "u", event("user_message", "Keep compatibility")));
	const prepared = unwrap(await memory.prepareCompaction("s", request));
	const before = store.load("s").state, old = before.blocks[0];
	const count = model.calls.filter(c => c.kind === "writer").length;
	const regenerated = unwrap(await memory.advanceMemory("s", { kind: "regenerate_block", blockId: old.id }));
	const after = store.load("s").state;
	assert.equal(after.blocks.length, 2); assert.equal(currentBlocks(after)[0].id, regenerated.derivedId);
	assert.equal(canonical(after.ledgers), canonical(before.ledgers)); assert.equal(canonical(after.events), canonical(before.events));
	assert.equal(model.calls.filter(c => c.kind === "writer").length, count);
	assert.equal(unwrap(await memory.advanceMemory("s", { kind: "regenerate_block", blockId: old.id })).derivedId, regenerated.derivedId);
	assert.equal(memory.activateHandoff("s", prepared.id, "0").ok, false);
	const fresh = unwrap(await memory.prepareCompaction("s", request)); assert.notEqual(fresh.id, prepared.id);
	assert.equal(fresh.derivedRevision, 1);
});

test("historical correction is a separately reviewed version, not replayed source", async () => {
	const { store, model, memory } = setup();
	unwrap(memory.recordEvent("s", "u", event("user_message", "Keep compatibility")));
	unwrap(await memory.advanceMemory("s", 1));
	const before = store.load("s").state, prior = before.ledgers.at(-1)!, item = prior.items[0];
	model.override = (kind, input) => kind === "reviewer" ? json({ verdict: "supported", evidence: input.proposal.mutation.evidence, explanation: "Scripted reviewer approves this test correction, not semantic acceptance." }) : undefined;
	const correction: DerivedUpdate = { kind: "reconcile", requestId: "correction-1", expectedLedgerVersion: prior.version, mutations: [{ item: { ...item, statement: "Preserve compatibility", version: 2 }, expectedVersion: 1, atEventId: item.sourceRefs[0].eventId, evidence: item.sourceRefs }], aliases: [] };
	unwrap(await memory.advanceMemory("s", correction));
	const after = store.load("s").state;
	assert.equal(after.ledgers.length, 2); assert.equal(canonical(after.ledgers[0]), canonical(prior));
	assert.equal(after.ledgers.at(-1)!.items[0].version, 2); assert.equal(after.minimumHandoffCutoff, 1);
	assert.equal(canonical(after.events), canonical(before.events));
	unwrap(await memory.advanceMemory("s", correction)); assert.equal(store.load("s").state.ledgers.length, 2);
	assert.equal(unwrap(await memory.prepareCompaction("s", request)).ledgerVersion, after.ledgers.at(-1)!.version);
});

test("a concurrent later ledger cannot be overwritten by historical reconciliation", async () => {
	const { store, model, memory, host } = setup();
	unwrap(memory.recordEvent("s", "u", event("user_message", "Keep compatibility")));
	unwrap(await memory.advanceMemory("s", 1));
	const prior = store.load("s").state.ledgers.at(-1)!, item = prior.items[0];
	let ready!: () => void, release!: () => void;
	const reviewing = new Promise<void>(resolve => { ready = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
	model.override = async (kind, input) => {
		if (kind !== "reviewer") return;
		ready(); await resume;
		return json({ verdict: "supported", evidence: input.proposal.mutation.evidence, explanation: "Scripted test verdict." });
	};
	const correction = memory.advanceMemory("s", { kind: "reconcile", requestId: "race", expectedLedgerVersion: prior.version, mutations: [{ item: { ...item, statement: "Preserve compatibility", version: 2 }, expectedVersion: 1, atEventId: item.sourceRefs[0].eventId, evidence: item.sourceRefs }], aliases: [] });
	await reviewing;
	const other = new SessionMemory(store, characterTokenizer, host, new FakeModel());
	unwrap(other.recordEvent("s", "new-user", event("user_message", "Also preserve the API")));
	unwrap(await other.advanceMemory("s", 2));
	const latest = canonical(store.load("s").state.ledgers.at(-1)); release();
	const result = await correction;
	assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, "REVISION_CONFLICT");
	assert.equal(canonical(store.load("s").state.ledgers.at(-1)), latest);
	assert.equal(store.load("s").state.ledgers.at(-1)!.items.length, 2);
});

test("ambiguous historical correction retains the item and publishes its conflict", async () => {
	const { store, memory } = setup();
	unwrap(memory.recordEvent("s", "u", event("user_message", "Keep compatibility")));
	unwrap(await memory.advanceMemory("s", 1));
	const prior = store.load("s").state.ledgers.at(-1)!, item = prior.items[0];
	unwrap(await memory.advanceMemory("s", { kind: "reconcile", requestId: "ambiguous", expectedLedgerVersion: prior.version, mutations: [{ item: { ...item, statement: "Preserve compatibility", version: 2 }, expectedVersion: 1, atEventId: item.sourceRefs[0].eventId, evidence: item.sourceRefs }], aliases: [] }));
	const latest = store.load("s").state.ledgers.at(-1)!;
	assert.equal(canonical(latest.items[0]), canonical(item));
	assert.equal(latest.transitions.at(-1)!.accepted, false);
	assert.equal(latest.transitions.at(-1)!.review!.verdict, "ambiguous");
	const handoff = unwrap(await memory.prepareCompaction("s", request));
	assert.match(canonical(handoff.rendered.payload), /proposedTransition/);
});

test("alias equivalence is explicit, reviewed, and cannot promote authority", async () => {
	const { store, model, memory } = setup();
	unwrap(memory.recordEvent("s", "u1", event("user_message", "Keep compatibility")));
	unwrap(memory.recordEvent("s", "u2", event("user_message", "Keep compatibility")));
	unwrap(await memory.advanceMemory("s", 2));
	const prior = store.load("s").state.ledgers.at(-1)!, [target, alias] = prior.items;
	model.override = (kind, input) => kind === "reviewer" ? json({ verdict: "supported", evidence: input.proposal.proposedEquivalence.evidence, explanation: "Scripted equivalence verdict." }) : undefined;
	unwrap(await memory.advanceMemory("s", { kind: "reconcile", requestId: "alias", expectedLedgerVersion: prior.version, mutations: [], aliases: [{ aliasId: alias.id, canonicalId: target.id, evidence: [...alias.sourceRefs, ...target.sourceRefs] }] }));
	const ledger = store.load("s").state.ledgers.at(-1)!;
	assert.equal(ledger.aliases?.[0].canonicalId, target.id);
	assert.equal(canonical(unwrap(memory.lookup("s", { kind: "item", id: alias.id }, { tokens: 10000 }))).includes(target.id), true);
	assert.equal((await memory.advanceMemory("s", { kind: "reconcile", requestId: "cycle", expectedLedgerVersion: ledger.version, mutations: [], aliases: [{ aliasId: target.id, canonicalId: alias.id, evidence: alias.sourceRefs }] })).ok, false);
});

test("a large older result advances the cutoff while preserving the newest tool result", async () => {
	const { memory } = setup();
	unwrap(memory.recordEvent("s", "u", sourceEvent("Keep compatibility")));
	unwrap(memory.recordEvent("s", "call", sourceEvent("read index", "tool_request", { toolCallId: "old", operationId: "old" })));
	const old = unwrap(memory.recordEvent("s", "result", sourceEvent("X".repeat(40000), "tool_result", { toolCallId: "old", operationId: "old", operationStatus: "completed" })));
	unwrap(memory.recordEvent("s", "a", sourceEvent("Inspect current files next", "agent_message")));
	unwrap(memory.recordEvent("s", "ls", sourceEvent("ls", "tool_request", { toolCallId: "new", operationId: "new" })));
	const latest = unwrap(memory.recordEvent("s", "ls-result", sourceEvent("parser.js", "tool_result", { toolCallId: "new", operationId: "new", operationStatus: "completed" })));
	const { cutoff: _, ...automatic } = request;
	const handoff = unwrap(await memory.prepareCompaction("s", automatic));
	assert.equal(handoff.cutoff, old.originalSequence); assert.ok(handoff.tailEventIds.includes(latest.id));
});

for (const point of ["payload_written", "payload_synced", "payload_linked", "directory_synced", "before_manifest_commit", "after_manifest_commit"] as StorageFaultPoint[]) test(`migration recovery at ${point} preserves one exact legacy manifest`, () => {
	const directory = mkdtempSync(join(tmpdir(), "l-mem-migrate-fault-"));
	try {
		const original = new SqliteStore(directory), memory = new SessionMemory(original, characterTokenizer, new FakeHost(), new FakeModel());
		const source = unwrap(memory.recordEvent("s", "u", event("user_message", "Keep compatibility")));
		const old = canonical({ ...original.load("s").state, schemaVersion: 1 }); original.close();
		const db = new DatabaseSync(join(directory, "state.sqlite"));
		db.prepare("UPDATE sessions SET payload=?,digest=? WHERE id='s'").run(old, hash(Buffer.from(old))); db.close();
		const crashing = new SqliteStore(directory, at => { if (at === point) throw new Error("migration interruption"); });
		assert.throws(() => crashing.load("s"), /migration interruption/); crashing.close();
		const recovered = new SqliteStore(directory), state = recovered.load("s").state;
		assert.equal(state.migrations!.length, 1); assert.equal(state.events[0].id, source.id);
		assert.equal(Buffer.from(recovered.read("s", state.migrations![0].previousManifestRef)).toString(), old);
		assert.equal(recovered.load("s").state.migrations!.length, 1); recovered.close();
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a live legacy owner blocks migration without rewriting the manifest", () => {
	const directory = mkdtempSync(join(tmpdir(), "l-mem-migrate-owner-"));
	try {
		const original = new SqliteStore(directory), memory = new SessionMemory(original, characterTokenizer, new FakeHost(), new FakeModel());
		unwrap(memory.recordEvent("s", "u", event("user_message", "Keep compatibility")));
		const old = canonical({ ...original.load("s").state, schemaVersion: 1, host: { version: 1, revision: 0, dispatches: [], queued: [], owner: { id: "legacy", hostname: hostname(), pid: process.pid } } }); original.close();
		const db = new DatabaseSync(join(directory, "state.sqlite"));
		db.prepare("UPDATE sessions SET payload=?,digest=? WHERE id='s'").run(old, hash(Buffer.from(old)));
		const reopened = new SqliteStore(directory);
		assert.throws(() => reopened.load("s"), /Stop the legacy host/);
		assert.equal(db.prepare("SELECT payload FROM sessions WHERE id='s'").get()!.payload, old);
		reopened.close(); db.close();
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("schema migration archives the exact previous manifest and preserves all source IDs", () => {
	const directory = mkdtempSync(join(tmpdir(), "l-mem-migrate-"));
	try {
		const store = new SqliteStore(directory), memory = new SessionMemory(store, characterTokenizer, new FakeHost(), new FakeModel());
		const source = unwrap(memory.recordEvent("s", "u", event("user_message", "Original evidence")));
		const state = store.load("s").state; store.close();
		const old = canonical({ ...state, schemaVersion: 1 }), db = new DatabaseSync(join(directory, "state.sqlite"));
		db.prepare("UPDATE sessions SET payload=?,digest=? WHERE id='s'").run(old, hash(Buffer.from(old))); db.close();
		const reopened = new SqliteStore(directory), migrated = reopened.load("s").state;
		assert.equal(migrated.schemaVersion, 2); assert.equal(migrated.events[0].id, source.id);
		assert.equal(Buffer.from(reopened.read("s", migrated.migrations![0].previousManifestRef)).toString(), old);
		assert.equal((readJson(reopened, "s", migrated.migrations![0].previousManifestRef) as any).schemaVersion, 1);
		assert.equal(reopened.load("s").state.migrations!.length, 1); reopened.close();
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
