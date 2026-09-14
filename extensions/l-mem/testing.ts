import type { ContextRequest, EventInput, ExtractionPage, Handoff, HostBinding, Json, ModelBinding, Result, SourceEvent, Tokenizer, WorkItem } from "./contracts.ts";
import { jsonRenderer } from "./context.ts";
import { canonical, json } from "./storage.ts";

/** Exact for the test protocol, where each Unicode code point is one token.
 * This is intentionally not a production-model tokenizer.
 */
export const testTokenizer: Tokenizer = { id: "fixture-codepoint-1", mode: "exact", count: text => Array.from(text).length };
export class FakeHost implements HostBinding {
	version = "fixture-host-1";
	archiveCapability = "fixture read capability resolves /fake references with FakeStore.read";
	revision = "v1";
	sendCount = 0;
	beforeActivate?: () => void;
	afterAccepted?: () => void;
	private accepted = new Map<string, { dispatchId: string; handoff: Handoff; state: "accepted" | "sent" | "unknown" }>();
	render = jsonRenderer;
	validateTail(tail: SourceEvent[], support: SourceEvent[]): Result<null> {
		const calls = new Set([...support, ...tail].filter(e => e.kind === "tool_request").map(e => e.toolCallId));
		return tail.some(e => e.kind === "tool_result" && !calls.has(e.toolCallId)) ? { ok: false, code: "ILLEGAL_TOOL_SEQUENCE", message: "Missing call", retryable: false } : { ok: true, value: null };
	}
	dispatch = {
		activate: (sessionId: string, handoffId: string, expected: string, refresh: () => Result<Handoff>): Result<{ dispatchId: string; handoff: Handoff; state: "accepted" | "sent" | "unknown" }> => {
			const key = `${sessionId}:${handoffId}`, old = this.accepted.get(key);
			if (old) return { ok: true, value: old };
			this.beforeActivate?.();
			if (expected !== this.revision) return { ok: false, code: "REVISION_CONFLICT", message: "Host revision changed", retryable: true };
			const handoff = refresh();
			if (!handoff.ok) return handoff;
			const accepted = { dispatchId: `dispatch:${key}`, handoff: handoff.value, state: "accepted" as const };
			this.accepted.set(key, accepted);
			this.revision = `${expected}:accepted:${accepted.dispatchId}`;
			this.afterAccepted?.(); // Crash here must not send twice on retry.
			this.sendCount++;
			return { ok: true, value: accepted };
		},
	};
}
export function event(payload: string, kind: EventInput["kind"] = "user_message", extra: Partial<EventInput> = {}): EventInput {
	return { kind, producer: kind === "user_message" ? "user" : "agent", authority: kind === "user_message" ? "user" : "agent", origin: "original", timestamp: 1, payload, message: { role: kind === "user_message" ? "user" : "assistant", content: payload }, causalParentIds: [], deliveryState: "delivered", coherentCut: true, ...extra };
}
export function contextRequest(extra: Partial<ContextRequest> = {}): ContextRequest {
	return { requestId: "request", contextRevision: "v1", capacity: 100_000, fixedTokens: 1_000, outputReserve: 1_000, safetyMargin: 100, unactedUserEventIds: [], ...extra };
}
export function extractionFor(input: Json): ExtractionPage {
	const data = input as any, source = data.source, event = source.event as SourceEvent;
	const ref = { sessionId: event.sessionId, eventId: event.id, span: { start: source.segment.start, end: source.segment.end, encoding: "utf8" as const }, observationScope: "fixture source span" };
	const item: WorkItem = { id: `${event.id}:item:${source.segment.start}:0`, kind: "task", statement: source.segment.text || "Empty fixture request", origin: "explicit_user", scope: "session", conditions: [], status: "active", sourceRefs: [ref], exactUserExcerptRefs: [ref], dependencies: [], supersedesIds: [], supersededByIds: [], completionEvidence: [], conflicts: [], createdAt: event.originalSequence!, lastTransition: event.originalSequence!, version: 1 };
	return {
		schemaVersion: 1, claims: event.kind === "user_message" ? [{ id: `${event.id}:claim:${source.segment.start}:0`, category: "explicit_user", text: item.statement, scope: item.scope, sourceRefs: [ref], itemIds: [item.id], entities: [], invalidatesIds: [] }] : [],
		mutations: event.kind === "user_message" ? [{ item, expectedVersion: null, atEventId: event.id, evidence: [ref] }] : [],
		receipts: event.kind === "user_message" ? [{ eventId: event.id, itemIds: [item.id], classification: "requirements", reason: "Fixture treats each user segment as a distinct obligation" }] : [], complete: true, nextCursor: null,
	};
}
/** A deterministic contract fake, not a semantic evaluator. */
export class FakeModel implements ModelBinding {
	identity = "scripted-fixture-model-1";
	calls: { kind: string; input: Json }[] = [];
	override?: (kind: string, source: any, call: number) => Json | Promise<Json | undefined> | undefined;
	async invoke(job: Parameters<ModelBinding["invoke"]>[0]): Promise<Json> {
		this.calls.push({ kind: job.kind, input: job.input });
		const input = (job.input as any).source;
		const overridden = await this.override?.(job.kind, input, this.calls.length);
		if (overridden !== undefined) return overridden;
		if (job.kind === "writer") {
			if (input.sources) {
				const start = input.cursor ? Number(String(input.cursor).slice(6)) : 0;
				const pages: any[] = []; let end = start;
				const output = () => ({ schemaVersion: 1, claims: pages.flatMap(p => p.claims), mutations: pages.flatMap(p => p.mutations), receipts: pages.flatMap(p => p.receipts), complete: end === input.sources.length, nextCursor: end === input.sources.length ? null : `batch:${end}` });
				for (; end < input.sources.length;) {
					pages.push(extractionFor({ ...input, source: input.sources[end++] }));
					if (pages.length > 1 && Buffer.byteLength(canonical(output())) > job.maxOutputTokens) { pages.pop(); end--; break; }
				}
				return json(output());
			}
			return json(extractionFor(input));
		}
		if (job.kind === "block") return json({ title: "Fixture history", claimIds: input.claims.map((c: any) => c.id) });
		if (job.kind === "reviewer") return json({ verdict: "ambiguous", evidence: input.mutation?.evidence ?? input.proposal?.mutation?.evidence ?? input.proposal?.proposedEquivalence?.evidence, explanation: "The fake never grants semantic authority to a destructive transition." });
		return json({ schemaVersion: 1, cutoff: input.cutoff, entries: input.items.map((i: any) => ({ itemId: i.id, category: i.kind === "constraint" ? "Goal" : "Remaining Work" })), nextAction: { text: "Inspect current workspace before modifying it.", origin: "agent_proposal", itemIds: input.items.slice(0, 1).map((i: any) => i.id), evidenceBlockIds: [], retrievalPrerequisites: [] }, conflictIds: input.conflictIds, requiredBlockIds: [] });
	}
}
export function unwrap<T>(result: Result<T>): T {
	if (!result.ok) throw new Error(canonical(result));
	return result.value;
}
