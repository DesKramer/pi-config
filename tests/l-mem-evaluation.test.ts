import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixtures } from "../extensions/l-mem/evaluation/fixtures.ts";
import { GRADER, seedWorkspace, boundedRecent, capacityGradingEvidence, checkpointEnd } from "../extensions/l-mem/evaluation/sdk-driver.ts";
import { nativeTokenizer } from "../extensions/l-mem/native-context.ts";
import { COMPACTIONS, releaseGate, trialMatrix, validateTrialResult, type TrialResult } from "../extensions/l-mem/evaluation/runner.ts";
import { FakeHost, FakeModel, contextRequest, event, testTokenizer, unwrap } from "../extensions/l-mem/testing.ts";
import { SessionMemory } from "../extensions/l-mem/memory.ts";
import { FakeStore, canonical } from "../extensions/l-mem/storage.ts";

test("all fourteen behavioral fixture contracts are annotated and acceptance cannot pass on structural checks", () => {
	assert.equal(fixtures.length, 14);
	assert.deepEqual(COMPACTIONS, [1, 3, 5, 10]);
	for (const fixture of fixtures) {
		assert.ok(fixture.trace.length && fixture.activeObligations.length && fixture.acceptableNextActions.length && fixture.prohibitedActions.length && fixture.completionEvidence.length && fixture.criticalViolations.length);
	}
	const gate = releaseGate([]);
	assert.equal(gate.enabled, false); assert.equal(gate.reasons.length, 56);
});

test("grading distinguishes retained context from completion without excusing contradictions", () => {
	assert.match(GRADER, /Retention is not completion/);
	assert.match(GRADER, /Do not report event_dropped solely because the final answer omits it/);
	assert.match(GRADER, /against acceptableNextActions/);
	assert.match(GRADER, /Still report contradictions/);
});

test("preference fixture specifies a reproducible fix and owns its Git discovery boundary", async t => {
	const directory = await mkdtemp(join(tmpdir(), "l-mem-eval-scope-")); t.after(() => rm(directory, { recursive: true, force: true }));
	const execute = promisify(execFile), cwd = join(directory, "workspace");
	await execute("git", ["init", "--quiet", "--template=", directory]);
	await writeFile(join(directory, "unrelated.txt"), "Outside fixture");
	const files = await seedWorkspace(cwd, "inferred-preference");
	assert.equal((await execute("git", ["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim(), await realpath(cwd));
	assert.doesNotMatch((await execute("git", ["-C", cwd, "status", "--porcelain"])).stdout, /unrelated/);
	assert.match(fixtures.find(f => f.id === "inferred-preference")!.trace.at(-1)!.event.payload as string, /normalizeName.*decomposed and composed/);
	const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
	await assert.rejects(execute(process.execPath, ["--test", "parser.test.js"], { cwd, env }), (error: any) => { assert.match(error.stdout, /canonical Unicode forms/); return error.code === 1; });
	await writeFile(join(cwd, "parser.js"), files["parser.js"].replace("return name;", 'return name.normalize("NFC");'));
	assert.match((await execute(process.execPath, ["--test", "parser.test.js"], { cwd, env })).stdout, /pass 4/);
});

test("capacity grading distinguishes preserved durable records from delivered context", () => {
	const ledger = { version: "l", cutoff: 1, items: [], claims: [], receipts: [], transitions: [], operations: [] };
	assert.deepEqual(capacityGradingEvidence("mandatory-capacity", "ACTIVE_STATE_TOO_LARGE: explicit refusal", ledger), { notDeliveredToModel: true, ledger });
	assert.equal(capacityGradingEvidence("early-compatibility", "ACTIVE_STATE_TOO_LARGE: failed continuation", ledger), undefined);
	assert.equal(capacityGradingEvidence("mandatory-capacity", "WRITER_INVALID: extraction failed", ledger), undefined);
	assert.equal(capacityGradingEvidence("mandatory-capacity", undefined, ledger), undefined);
});

test("checkpoint seeds perturb intermediate replay without changing final coverage", () => {
	assert.notEqual(checkpointEnd(100, 1, 3, 3), checkpointEnd(100, 1, 3, 20));
	assert.equal(checkpointEnd(100, 3, 3, 3), 100);
	assert.equal(checkpointEnd(100, 3, 3, 20), 100);
});

test("recent baseline cannot gain context by exceeding its budget or dropping a live tool group", () => {
	const tool = [{ role: "assistant", content: [{ type: "toolCall", id: "a" }, { type: "toolCall", id: "b" }] }, { role: "toolResult", toolCallId: "a", content: "A" }, { role: "toolResult", toolCallId: "b", content: "B" }];
	const budget = nativeTokenizer.count(canonical(tool));
	assert.deepEqual(boundedRecent([{ role: "user", content: "X".repeat(1000) }, ...tool], budget), tool);
	assert.throws(() => boundedRecent(tool, budget - 1), /cannot retain/);
	assert.throws(() => boundedRecent([{ role: "user", content: "X".repeat(1000) }], 100), /cannot retain/);
});

test("missing and inflated metrics cannot satisfy behavioral acceptance", () => {
	const request = trialMatrix(1, { cases: ["early-compatibility"], compactions: [1], targets: [12500], strategies: ["l-mem"] })[0];
	const result: TrialResult = { status: "measured", actualCompactions: 1, mainAgentIdentity: "schema-test-only", writerIdentity: "schema-test-only", graderIdentity: "schema-test-only", graderIndependentOfWriter: true, traceRef: "not-real-evidence", graderEvidenceRefs: ["not-real-evidence"], criticalViolations: [], metrics: { accurateObligations: 2, annotatedObligations: 2, nextActionSuccess: 1, prohibitedActions: 0, incorrectClosures: 0, unjustifiedRepetitions: 0, inferencePromotions: 0, lookupSuccess: 0, contradictions: 0, preparationMs: 1, modelTokens: 1, lookupCost: 0 } };
	assert.doesNotThrow(() => validateTrialResult(request, result));
	assert.equal(releaseGate([{ request, result }]).enabled, false);
	const failed = { ...result, failure: "MAIN_AGENT_FAILED: opaque reasoning is unsupported" };
	assert.doesNotThrow(() => validateTrialResult(request, failed));
	assert.ok(releaseGate([{ request, result: failed }]).reasons.some(reason => reason.startsWith("Trial failed:")));
	assert.throws(() => validateTrialResult(request, { ...result, failure: "" }), /trial failure/);
	assert.throws(() => validateTrialResult(request, { ...result, metrics: {} as any }), /counter/);
	assert.throws(() => validateTrialResult(request, { ...result, metrics: { ...result.metrics, accurateObligations: 3 } }), /counts/);
	assert.throws(() => validateTrialResult(request, { ...result, metrics: { ...result.metrics, nextActionSuccess: 2 } }), /counts/);
	assert.equal(releaseGate([{ request, result: { ...result, metrics: {} as any } }]).enabled, false);
});

test("token accounting includes actual serialized continuity framing", async () => {
	const store = new FakeStore(), memory = new SessionMemory(store, testTokenizer, new FakeHost(), new FakeModel());
	unwrap(memory.recordEvent("s", "u", event("Preserve compatibility")));
	const handoff = unwrap(await memory.prepareCompaction("s", contextRequest({ cutoff: 1 })));
	const rendered = handoff.rendered;
	assert.equal(rendered.counts.total, testTokenizer.count(rendered.history + rendered.trajectory + rendered.tail));
	assert.deepEqual(JSON.parse(rendered.history + rendered.trajectory + rendered.tail), rendered.payload);
});

test("missing artifacts invalidate prepared handoff reuse", async () => {
	const store = new FakeStore(), memory = new SessionMemory(store, testTokenizer, new FakeHost(), new FakeModel());
	const source = unwrap(memory.recordEvent("s", "u", event("Keep compatibility")));
	unwrap(await memory.prepareCompaction("s", contextRequest({ cutoff: 1 })));
	store.remove(source.payloadRef);
	const result = await memory.prepareCompaction("s", contextRequest({ cutoff: 1 }));
	assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, "MISSING_ARTIFACT");
});

test("model timeout is bounded, retried, and leaves original source uncovered", async () => {
	const store = new FakeStore();
	let invocations = 0;
	const model = new FakeModel();
	model.override = async () => { invocations++; return await new Promise<never>(() => {}); };
	const memory = new SessionMemory(store, testTokenizer, new FakeHost(), model, { jobTimeoutMs: 5 });
	unwrap(memory.recordEvent("s", "u", event("Retain this request")));
	const result = await memory.advanceMemory("s", 1);
	assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, "WRITER_INVALID");
	assert.equal(invocations, 3);
	assert.equal(unwrap(memory.inspect("s")).validatedWatermark, 0);
	assert.equal(store.load("s").state.events.length, 1);
});

test("source events with invalid Unicode cannot silently change during UTF-8 archival", () => {
	const memory = new SessionMemory(new FakeStore(), testTokenizer, new FakeHost(), new FakeModel());
	const result = memory.recordEvent("s", "u", event("unpaired \uD800"));
	assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, "INVALID_EVENT");
});

test("binary payloads remain recoverable without claiming an unseen interpretation", () => {
	const store = new FakeStore(), memory = new SessionMemory(store, testTokenizer, new FakeHost(), new FakeModel());
	unwrap(memory.recordEvent("s", "image", event("Image supplied without a text interpretation", "agent_message", { artifacts: [{ content: Buffer.from([0xff, 0x00, 0xab, 0xef]).toString("base64"), encoding: "base64", mediaType: "image/png", captureKind: "agent_visible", completeness: "complete" }] })));
	const artifact = store.load("s").state.artifacts[1];
	const result = unwrap(memory.lookup("s", { kind: "reference", ref: artifact.storageRef }, { tokens: 1200 }));
	assert.equal((result.results[0] as any).encoding, "base64");
	assert.equal((result.results[0] as any).text, "/wCr7w==");
	assert.doesNotMatch(canonical(result), /image shows/);
});
