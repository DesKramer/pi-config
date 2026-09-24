import test from "node:test";
import assert from "node:assert/strict";
import { FakeStore, canonical, json, readJson, saveJson, update } from "../extensions/l-mem/storage.ts";
import { receiptKeys, reasoningAccounting } from "../extensions/l-mem/reasoning.ts";
import { nativeHost, nativeTokenizer } from "../extensions/l-mem/native-context.ts";
import { SessionMemory } from "../extensions/l-mem/memory.ts";
import { FakeModel, event, unwrap } from "../extensions/l-mem/testing.ts";
import { boundedRecent } from "../extensions/l-mem/evaluation/sdk-driver.ts";

const model = { provider: "openai", id: "fixture", api: "openai-responses" };
const reasoning = (id = "rs_1") => ({ type: "reasoning", id, summary: [], encrypted_content: "opaque-not-a-token-count" });
function message(items = [reasoning()]): any {
	return { role: "assistant", provider: model.provider, api: model.api, model: model.id, stopReason: "stop", timestamp: 1,
		content: [...items.map(item => ({ type: "thinking", thinking: "", thinkingSignature: canonical(item) })), { type: "text", text: "Pending." }],
		usage: { input: 200, output: 300, reasoning: 250, totalTokens: 500 } };
}
function journal(store: FakeStore, message: any, sessionId = "s") {
	const responseRef = saveJson(store, sessionId, { model, message });
	update(store, sessionId, state => {
		state.host ??= { version: 1, revision: 0, queued: [], dispatches: [] };
		(state.host.responses ??= []).push({ responseRef, reasoningKeys: receiptKeys(message) });
	});
	return responseRef;
}

test("opaque accounting charges the full recorded response output per item and per replay", () => {
	const store = new FakeStore(), original = message([reasoning(), reasoning("rs_2")]);
	const ref = journal(store, original), accounting = reasoningAccounting(store, "s");
	original.usage.output = 1; original.usage.reasoning = 0; // Mutable SDK metadata is not the receipt.
	assert.equal(accounting.messages([original]).tokens, 600);
	assert.deepEqual(accounting.messages([original]).responseRefs, [ref]);
	assert.equal(accounting.messages([original, original]).tokens, 1200);
	assert.equal(accounting.payload({ model: model.id, input: [reasoning(), reasoning("rs_2")] }, model).tokens, 600);
	assert.equal((readJson(store, "s", ref) as any).message.usage.output, 300);
});

test("only decoded reasoning ciphertext is excluded from the accounting view, never from dispatch", () => {
	const store = new FakeStore(), cipher = "x".repeat(80000), opaque = { ...reasoning(), encrypted_content: cipher };
	const original = message([opaque]); journal(store, original);
	const account = reasoningAccounting(store, "s"), result = account.messages([original]);
	assert.equal(result.tokens, 300);
	assert.ok(nativeTokenizer.count(canonical(result.counted)) < 1000);
	assert.equal(JSON.parse(original.content[0].thinkingSignature).encrypted_content, cipher);
	const payload = { model: model.id, input: [opaque, { role: "user", content: [{ type: "input_text", text: cipher }] }, { type: "function_call", name: "write", arguments: canonical({ encrypted_content: cipher }) }] };
	const counted = account.payload(payload, model).counted;
	assert.equal(counted.input[0].encrypted_content, "");
	assert.deepEqual(counted.input.slice(1), payload.input.slice(1));
	assert.equal((payload.input[0] as typeof opaque).encrypted_content, cipher);
	assert.ok(nativeTokenizer.count(canonical(counted)) > 160000);
});

test("missing, mismatched, malformed and incomplete reasoning evidence fails closed", () => {
	const store = new FakeStore(), original = message();
	assert.throws(() => reasoningAccounting(store, "s").messages([original]), /no journaled/);
	journal(store, original, "other");
	assert.throws(() => reasoningAccounting(store, "s").messages([original]), /no journaled/);
	const ref = journal(store, original);
	assert.throws(() => reasoningAccounting(store, "s").messages([{ ...original, model: "other" }]), /no journaled/);
	const changed = message([{ ...reasoning(), encrypted_content: "changed" }]);
	assert.throws(() => reasoningAccounting(store, "s").messages([changed]), /no journaled/);
	assert.throws(() => reasoningAccounting(store, "s").messages([{ ...original, api: "anthropic-messages" }]), /only for journaled/);
	assert.throws(() => reasoningAccounting(store, "s").messages([{ ...original, content: [{ type: "thinking", thinkingSignature: "not-json" }] }]), /Unrecognized/);
	store.remove(ref);
	assert.throws(() => reasoningAccounting(store, "s").messages([original]), { code: "MISSING_ARTIFACT" });
	for (const change of [{ stopReason: "error" }, { stopReason: "aborted" }, { usage: { output: 0, reasoning: 0, totalTokens: 0 } }, { usage: { output: 20, reasoning: 30, totalTokens: 40 } }, { usage: { output: -1, reasoning: 0, totalTokens: 10 } }]) {
		const isolated = new FakeStore(), invalid = { ...message(), ...change }; journal(isolated, invalid);
		assert.throws(() => reasoningAccounting(isolated, "s").messages([invalid]), /no journaled/);
	}
});

test("provider payload accounting rejects implicit context and opaque non-reasoning items", () => {
	const store = new FakeStore(); journal(store, message());
	const account = reasoningAccounting(store, "s");
	for (const payload of [{ input: [], previous_response_id: "resp_old" }, { input: [], context_management: [] }, { input: [], truncation: "auto" }, { input: [{ type: "item_reference", id: "rs_1" }] }, { input: [{ type: "compaction", encrypted_content: "unknown" }] }]) assert.throws(() => account.payload({ model: model.id, ...payload }, model), /not supported|lack/);
	assert.throws(() => account.payload({ model: "other", input: [] }, model), /selected model/);
	assert.throws(() => account.payload({ model: "other", input: [reasoning()] }, { ...model, id: "other" }), /no journaled/);
	assert.throws(() => account.payload({ model: model.id, messages: [{ reasoning_details: [{ type: "reasoning.encrypted" }] }] }, { ...model, api: "openai-completions" }), /no supported/);
});

test("native preparation includes opaque charges without changing original protocol or evidence", async () => {
	const store = new FakeStore(), host = nativeHost(store, "s", "/fake"), memory = new SessionMemory(store, nativeTokenizer, host, new FakeModel());
	const original = message(), ref = journal(store, original);
	const source = unwrap(memory.recordEvent("s", "assistant", event("Pending.", "agent_message", { message: json(original) })));
	const request = { requestId: "r", contextRevision: "0", cutoff: 0, capacity: 128000, fixedTokens: 1000, outputReserve: 4096, safetyMargin: 4096, unactedUserEventIds: [] };
	const prepared = unwrap(await memory.prepareCompaction("s", request));
	const excluded = Buffer.byteLength(reasoning().encrypted_content);
	assert.equal(prepared.rendered.counts.total, nativeTokenizer.count(canonical(prepared.rendered.payload)) - excluded + 300);
	assert.equal(prepared.rendered.counts.total, prepared.rendered.counts.history + prepared.rendered.counts.trajectory + prepared.rendered.counts.tail);
	assert.deepEqual(prepared.rendered.accounting, { profile: "responses-output-bound-v2", supplementalTokens: 300, excludedEncodedBytes: excluded, responseRefs: [ref] });
	assert.deepEqual((prepared.rendered.payload as any[]).at(-1), original);
	assert.deepEqual(readJson(store, "s", source.messageRef!), original);
	store.remove(ref);
	const retry = await memory.prepareCompaction("s", { ...request, requestId: "retry" });
	assert.equal(retry.ok, false);
});

test("reasoning is charged to the recent-only budget, not merely the model capacity", () => {
	const store = new FakeStore(), original = message(); journal(store, original);
	const raw = nativeTokenizer.count(canonical(reasoningAccounting(store, "s").messages([original]).counted));
	const count = (messages: any[]) => { const a = reasoningAccounting(store, "s").messages(messages); return nativeTokenizer.count(canonical(a.counted)) + a.tokens; };
	assert.throws(() => boundedRecent([original], 35000), /supply a journaled/);
	assert.throws(() => boundedRecent([original], raw + 299, count), /cannot retain/);
	assert.deepEqual(boundedRecent([original], raw + 300, count), [original]);
});
