import type { Json, Store } from "./contracts.ts";
import { canonical, digest, fail, readJson } from "./storage.ts";

export interface ProviderReceipt { responseRef: string; reasoningKeys: string[] }
export interface ProviderIdentity { provider: string; id: string; api: string }
export interface ReasoningCharge { tokens: number; responseRefs: string[] }
const responses = new Set(["openai-responses", "openai-codex-responses"]);

function item(signature: unknown): Record<string, Json> {
	if (typeof signature !== "string") fail("UNSUPPORTED_HOST_CAPABILITY", "Reasoning replay needs a complete Responses reasoning item");
	let value: any;
	try { value = JSON.parse(signature); } catch { fail("UNSUPPORTED_HOST_CAPABILITY", "Unrecognized reasoning signature; original data remains archived"); }
	if (!value || value.type !== "reasoning" || typeof value.id !== "string" || !Array.isArray(value.summary) || typeof value.encrypted_content !== "string" || !value.encrypted_content) fail("UNSUPPORTED_HOST_CAPABILITY", "Reasoning replay needs an encrypted Responses item with identity and summary");
	return value;
}
function parts(message: any): Record<string, Json>[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content.filter((p: any) => p.type === "thinking" && (p.thinkingSignature || p.redacted)).map((p: any) => {
		if (!responses.has(message.api) || p.redacted) fail("UNSUPPORTED_HOST_CAPABILITY", "Opaque reasoning is supported only for journaled OpenAI Responses items");
		return item(p.thinkingSignature);
	});
}
/** Index only; the bound is reread from the immutable response when used. */
export function receiptKeys(message: unknown): string[] {
	try { return parts(message).map(p => digest(p)); } catch { return []; }
}

/** OpenAI bills reasoning as output tokens. Charge the ENTIRE response output
 * for EACH replayed reasoning item. Count the remaining protocol as UTF-8,
 * excluding ciphertext only in a separate accounting view: it is decrypted
 * reasoning, not literal model-visible text. Never alter the dispatched item.
 * This overcounts visible output and multi-item responses. Never infer decoded
 * size from ciphertext length or mutable message usage.
 * https://developers.openai.com/api/docs/guides/reasoning
 */
export function reasoningAccounting(store: Store, sessionId: string) {
	const state = store.load(sessionId).state;
	const index = new Map<string, ProviderReceipt[]>();
	for (const receipt of state.host?.responses ?? []) for (const key of receipt.reasoningKeys) index.set(key, [...index.get(key) ?? [], receipt]);
	const loaded = new Map<string, any>();
	function bound(value: Record<string, Json>, owner?: { provider: string; model: string; api: string }): { tokens: number; ref: string } {
		const key = digest(value), candidates = index.get(key) ?? [];
		let best: { tokens: number; ref: string } | undefined;
		for (const candidate of candidates) {
			let saved = loaded.get(candidate.responseRef);
			if (!saved) { saved = readJson(store, sessionId, candidate.responseRef); loaded.set(candidate.responseRef, saved); }
			const message = saved.message, model = saved.model as ProviderIdentity;
			if (!responses.has(model?.api) || message?.role !== "assistant" || message.provider !== model.provider || message.model !== model.id || message.api !== model.api) fail("STORAGE_ERROR", "Provider response identity does not match its receipt");
			if (owner && (owner.provider !== model.provider || owner.model !== model.id || owner.api !== model.api)) continue;
			if (!parts(message).some(p => digest(p) === key)) fail("STORAGE_ERROR", "Reasoning receipt does not contain its indexed item");
			if (!["stop", "toolUse", "length"].includes(message.stopReason)) continue;
			const usage = message.usage;
			if (!usage || !Number.isSafeInteger(usage.output) || usage.output <= 0 || !Number.isSafeInteger(usage.reasoning) || usage.reasoning < 0 || usage.reasoning > usage.output || !Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < usage.output) continue;
			if (!best || usage.output > best.tokens) best = { tokens: usage.output, ref: candidate.responseRef };
		}
		return best ?? fail("UNSUPPORTED_HOST_CAPABILITY", "Reasoning has no journaled provider output-token bound. Its original data remains archived; do not guess its decoded size.");
	}
	function charge(values: { item: Record<string, Json>; owner?: { provider: string; model: string; api: string } }[]): ReasoningCharge {
		let tokens = 0; const refs = new Set<string>();
		for (const value of values) { const cost = bound(value.item, value.owner); tokens += cost.tokens; refs.add(cost.ref); }
		if (!Number.isSafeInteger(tokens)) fail("CONTEXT_BUDGET_EXCEEDED", "Reasoning token bound exceeds safe accounting range");
		return { tokens, responseRefs: [...refs] };
	}
	return {
		messages(messages: readonly any[]): ReasoningCharge & { counted: any[] } {
			const values: { item: Record<string, Json>; owner: any }[] = [];
			const counted = messages.map(message => {
				const encrypted = parts(message); if (!encrypted.length) return message;
				values.push(...encrypted.map(item => ({ item, owner: message })));
				let index = 0;
				return { ...message, content: message.content.map((p: any) => p.type === "thinking" && p.thinkingSignature ? { ...p, thinkingSignature: canonical({ ...encrypted[index++], encrypted_content: "" }) } : p) };
			});
			return { ...charge(values), counted };
		},
		payload(payload: any, model: ProviderIdentity): ReasoningCharge & { counted: any } {
			const api = model.api;
			if (payload.model !== model.id) fail("UNSUPPORTED_HOST_CAPABILITY", "Provider payload changed or omitted the selected model identity");
			if (payload.previous_response_id || payload.conversation || payload.context_management || payload.truncation === "auto") fail("UNSUPPORTED_HOST_CAPABILITY", "Unaccounted server-side context or automatic truncation is not supported");
			if (responses.has(api)) {
				if (!Array.isArray(payload.input)) fail("UNSUPPORTED_HOST_CAPABILITY", "Responses accounting requires an explicit input array");
				if (payload.input.some((p: any) => p.type === "compaction" || p.type === "item_reference")) fail("UNSUPPORTED_HOST_CAPABILITY", "Opaque compaction or server-side item references lack an input-token bound");
				const values: { item: Record<string, Json>; owner: { provider: string; model: string; api: string } }[] = [];
				const input = payload.input.map((p: any) => {
					if (p.type !== "reasoning") return p;
					values.push({ item: item(canonical(p)), owner: { provider: model.provider, model: model.id, api } });
					return { ...p, encrypted_content: "" };
				});
				return { ...charge(values), counted: { ...payload, input } };
			}
			if (payload.messages?.some((m: any) => m.reasoning_details?.some((p: any) => p.type === "reasoning.encrypted"))) fail("UNSUPPORTED_HOST_CAPABILITY", "Encrypted Chat Completions reasoning has no supported accounting profile");
			return { tokens: 0, responseRefs: [], counted: payload };
		},
	};
}
