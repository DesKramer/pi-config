import test from "node:test";
import assert from "node:assert/strict";
import { modelJson, finalText } from "../extensions/l-mem/model-output.ts";
import { memoryModel } from "../extensions/l-mem/evaluation/pi-session.ts";
import { piMemoryModel } from "../extensions/l-mem/pi-adapter.ts";
import { Generation } from "../extensions/l-mem/generation.ts";
import { FakeStore, readJson } from "../extensions/l-mem/storage.ts";
import { publishedReferences } from "../extensions/l-mem/storage.ts";
import { DEFAULT_CONFIG } from "../extensions/l-mem/contracts.ts";
import { testTokenizer } from "../extensions/l-mem/testing.ts";

const model = { provider: "fixture", id: "fixture", api: "openai-codex-responses", maxTokens: 12000 };
const part = (text: string, phase?: string) => ({ type: "text", text, ...(phase ? { textSignature: JSON.stringify({ v: 1, id: `msg_${phase}`, phase }) } : {}) });
const response = (content: any[]) => ({ ...model, model: model.id, role: "assistant", stopReason: "stop", content, usage: { totalTokens: 10 } });

test("phased structured output selects the final answer without joining duplicate commentary JSON", () => {
	const value = response([part('{"read":{"ref":"source","offset":0}}', "commentary"), part('{"read":{"ref":"source","offset":0}}', "final_answer")]);
	assert.deepEqual(modelJson(value), { read: { ref: "source", offset: 0 } });
	assert.equal(value.content.length, 2);
	assert.equal(finalText(response([part("Planning", "commentary"), part("Summary", "final_answer")])), "Summary");
	assert.deepEqual(modelJson(response([part('{"ok":true}')])), { ok: true });
	assert.throws(() => modelJson(response([part('{"ok":true}'), part('{"other":true}')])), /invalid JSON/);
	assert.throws(() => modelJson(response([part("Unclassified"), part('{"ok":true}', "final_answer")])), /Unclassified/);
	assert.throws(() => modelJson(response([part('{"ok":true}', "final_answer"), part('{"other":true}', "final_answer")])), /invalid JSON/);
	assert.throws(() => modelJson({ ...value, api: "unknown" }), /invalid JSON/);
});

test("both SDK memory bindings retain terminal responses before parsing, including malformed output", async () => {
	for (const adapter of ["evaluation", "extension"]) {
		const store = new FakeStore(), raw = response([part("not JSON", "final_answer")]);
		const runtime = { async complete(_model: any, _context: any, options: any) { assert.equal(options.maxRetries, 0); assert.equal(options.transport, "sse"); return raw; } };
		const binding = adapter === "evaluation" ? memoryModel(runtime, model) : piMemoryModel({ model, modelRegistry: runtime } as any, new AbortController().signal)!;
		const generation = new Generation(store, testTokenizer, binding, { ...DEFAULT_CONFIG, repairs: 0 }, Date.now);
		await assert.rejects(generation.job("s", "trajectory", {}, value => value), /invalid JSON/);
		const state = store.load("s").state, job = state.jobs[0];
		assert.equal(job.state, "invalid");
		assert.equal(job.responses?.length, 1);
		assert.equal(job.responses![0].attempt, 0);
		assert.equal(job.attempts[0].providerUsage?.length, 1);
		const ref = job.responses![0].responseRef;
		assert.ok(publishedReferences(state).has(ref));
		raw.content[0].text = "changed later";
		assert.equal((readJson(store, "s", ref) as any).content[0].text, "not JSON");
	}
});
