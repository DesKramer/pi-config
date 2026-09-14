import type { Claim, EvidenceRef, ExtractionPage, Ledger, Mutation, SessionState, SourceEvent, Store, WorkItem } from "./contracts.ts";
import { canonical, fail, hash } from "./storage.ts";
export const OPEN = new Set(["active", "deferred", "unresolved"]);
export function object(value: unknown): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("WRITER_INVALID", "Expected an object");
}
export function string(value: unknown): asserts value is string {
	if (typeof value !== "string" || !value.trim()) fail("WRITER_INVALID", "Expected nonempty string");
}
export function array(value: unknown, path = "value"): asserts value is unknown[] { if (!Array.isArray(value)) fail("WRITER_INVALID", `${path} must be an array, including when empty`); }
export function strings(value: unknown, path = "value"): asserts value is string[] { array(value, path); value.forEach(string); }
export function oneOf(value: unknown, allowed: string[]) { if (!allowed.includes(value as string)) fail("WRITER_INVALID", `Invalid enum ${String(value)}`); }
export function integer(value: unknown) { if (!Number.isSafeInteger(value) || (value as number) < 0) fail("WRITER_INVALID", "Expected nonnegative integer"); }
export function unique(ids: string[]) { if (new Set(ids).size !== ids.length) fail("WRITER_INVALID", "Duplicate IDs"); }
export function evidence(ref: EvidenceRef, state: SessionState, store: Store, allowedEventIds: Set<string>, allowedSpans?: Map<string, { start: number; end: number }>): SourceEvent {
	object(ref); string(ref.eventId); string(ref.observationScope);
	if (ref.sessionId !== state.sessionId || !allowedEventIds.has(ref.eventId)) fail("WRITER_INVALID", "Evidence is outside declared source inputs");
	const event = state.events.find(e => e.id === ref.eventId && e.origin === "original");
	if (!event) fail("WRITER_INVALID", "Evidence is not an original event");
	const artifactId = ref.artifactId ?? event.artifactIds[0];
	const artifact = state.artifacts.find(a => a.id === artifactId && a.sessionId === state.sessionId && a.eventIds.includes(event.id));
	if (!artifact || artifact.completeness === "unavailable") fail("MISSING_ARTIFACT", `Missing evidence artifact ${artifactId}`);
	if (artifact.captureKind === "auxiliary_capture") fail("WRITER_INVALID", "Auxiliary capture was not agent-visible evidence. Record an explicit analysis first.");
	const bytes = store.read(state.sessionId, artifact.storageRef);
	if (hash(bytes) !== artifact.hash || (ref.contentHash && ref.contentHash !== artifact.hash)) fail("WRITER_INVALID", "Evidence hash mismatch");
	if (ref.workspaceVersion && ref.workspaceVersion !== event.workspaceVersion && ref.workspaceVersion !== artifact.versionIdentity) fail("WRITER_INVALID", "Unobserved workspace identity");
	if (ref.quote !== undefined) {
		string(ref.quote);
		const literal = Buffer.from(ref.quote, "utf8"), buffer = Buffer.from(bytes);
		const shown = allowedSpans?.get(event.id);
		if (ref.span) {
			if (!buffer.subarray(ref.span.start, ref.span.end).equals(literal)) fail("WRITER_INVALID", "Evidence quote and explicit span disagree");
		} else {
			const start = buffer.indexOf(literal, shown?.start ?? 0), second = buffer.indexOf(literal, start + 1);
			if (start < 0 || start + literal.length > (shown?.end ?? bytes.length) || second >= 0 && second < (shown?.end ?? bytes.length)) fail("WRITER_INVALID", `Evidence quote is absent or ambiguous for ${ref.eventId}; use the supplied defaultEvidence or an exact unique quote`);
			ref.span = { start, end: start + literal.length, encoding: "utf8" };
		}
	}
	if (ref.span) {
		object(ref.span); integer(ref.span.start); integer(ref.span.end);
		if (ref.span.encoding !== "utf8" || ref.span.start > ref.span.end || ref.span.end > bytes.length) fail("WRITER_INVALID", "Evidence span is outside the immutable artifact");
		try { new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(ref.span.start, ref.span.end)); }
		catch { fail("WRITER_INVALID", "Evidence splits a UTF-8 character"); }
	}
	const span = allowedSpans?.get(event.id);
	if (span && artifact.storageRef === event.payloadRef && (!ref.span || ref.span.start < span.start || ref.span.end > span.end)) fail("WRITER_INVALID", "Evidence escapes the segment shown to the writer");
	return event;
}
function refs(value: unknown): asserts value is EvidenceRef[] { array(value); if (!value.length) fail("WRITER_INVALID", "Substantive entry lacks evidence"); value.forEach(object); }
export function workItem(item: WorkItem) {
	object(item);
	for (const key of ["id", "statement", "scope"] as const) string(item[key]);
	oneOf(item.kind, ["objective", "task", "constraint", "exclusion", "acceptance_criterion", "question", "preference_inference"]);
	oneOf(item.origin, ["explicit_user", "inferred_user", "agent_proposal"]);
	oneOf(item.status, ["active", "deferred", "completed", "cancelled", "superseded", "unresolved"]);
	for (const key of ["conditions", "dependencies", "supersedesIds", "supersededByIds", "conflicts"] as const) {
		if (!Array.isArray(item[key])) fail("WRITER_INVALID", `WorkItem.${key} must be an array, including when empty`);
		strings(item[key]);
	}
	array(item.sourceRefs, "WorkItem.sourceRefs"); refs(item.sourceRefs); array(item.exactUserExcerptRefs, "WorkItem.exactUserExcerptRefs"); array(item.completionEvidence, "WorkItem.completionEvidence");
	for (const key of ["version", "createdAt", "lastTransition"] as const) integer(item[key]);
	if (!item.version) fail("WRITER_INVALID", "Item version must start at one");
	if (item.status === "deferred") string(item.deferralReason);
	if (item.origin === "inferred_user") string(item.inferenceBasis);
}
function observedExecution(event: SourceEvent, store: Store): boolean {
	if (event.kind !== "operation_status" || event.authority !== "host") return false;
	const payload = Buffer.from(store.read(event.sessionId, event.payloadRef)).toString("utf8");
	let value: any;
	try { value = JSON.parse(payload); } catch { return false; }
	const execution = value?.execution;
	return value?.tool === "bash" && typeof execution?.command === "string" && !!execution.command.trim() && typeof execution.cwd === "string" && !!execution.cwd.trim() && Number.isSafeInteger(execution.exitCode) && event.operationStatus === (execution.exitCode === 0 ? "completed" : "failed");
}
export function validatePage(value: unknown, state: SessionState, store: Store, ownedIds: Set<string>, inputs: Set<string>, spans: Map<string, { start: number; end: number }>): ExtractionPage {
	value = structuredClone(value);
	object(value);
	if (value.schemaVersion !== 1 || typeof value.complete !== "boolean") fail("WRITER_INVALID", "Extraction version or completion marker missing");
	if (value.complete ? value.nextCursor !== null : typeof value.nextCursor !== "string" || !value.nextCursor) fail("WRITER_INVALID", "Extraction pagination is incomplete");
	array(value.claims, "Extraction.claims"); array(value.mutations, "Extraction.mutations"); array(value.receipts, "Extraction.receipts");
	const page = value as unknown as ExtractionPage;
	for (const claim of page.claims) {
		object(claim); string(claim.id); string(claim.text); string(claim.scope);
		oneOf(claim.category, ["explicit_user", "inferred_user", "agent_proposal", "hypothesis", "observation", "planned", "attempted", "changed", "tested", "completed"]);
		strings(claim.itemIds, "Claim.itemIds"); strings(claim.entities, "Claim.entities"); strings(claim.invalidatesIds, "Claim.invalidatesIds"); array(claim.sourceRefs, "Claim.sourceRefs"); refs(claim.sourceRefs);
		const events = claim.sourceRefs.map(r => evidence(r, state, store, inputs, spans));
		if (!events.some(e => ownedIds.has(e.id))) fail("WRITER_INVALID", "New claim lacks owned evidence");
		if (!events.some(e => claim.id.startsWith(`${e.id}:claim:`))) fail("WRITER_INVALID", "New claim ID must derive from its source event");
		if (claim.category === "explicit_user" && !events.some(e => e.authority === "user" && e.kind === "user_message")) fail("WRITER_INVALID", "Tool content or agent proposal cannot become user authority");
		if (["changed", "tested", "completed"].includes(claim.category) && !events.some(e => e.kind === "tool_result" || e.kind === "workspace_change" || (claim.category === "completed" && e.kind === "agent_message") || (claim.category === "tested" && observedExecution(e, store)))) fail("WRITER_INVALID", `Claim ${claim.id} (${claim.category}) lacks an observed result. Use tool-result/workspace-change evidence; tested also permits a host command/cwd/exit-code record. Intent or generic lifecycle status is only planned/attempted/observation.`);
		if (claim.workspaceVersion && !events.some(e => e.workspaceVersion === claim.workspaceVersion)) fail("WRITER_INVALID", "Claim invents a workspace identity");
	}
	for (const mutation of page.mutations) {
		object(mutation); workItem(mutation.item); string(mutation.atEventId); array(mutation.evidence, "Mutation.evidence"); refs(mutation.evidence);
		if (!ownedIds.has(mutation.atEventId)) fail("WRITER_INVALID", "Mutation is outside owned coverage");
		if (mutation.expectedVersion !== null) integer(mutation.expectedVersion);
		const position = state.events.find(e => e.id === mutation.atEventId)!.originalSequence!;
		if (mutation.item.lastTransition !== position) fail("WRITER_INVALID", `Mutation ${mutation.item.id}: lastTransition must be ${position}, the atEventId originalSequence, not its timestamp`);
		if (mutation.expectedVersion === null) {
			if (!mutation.item.id.startsWith(`${mutation.atEventId}:item:`)) fail("WRITER_INVALID", "New item identity must derive from its owned event");
			if (mutation.item.createdAt !== position) fail("WRITER_INVALID", `Mutation ${mutation.item.id}: createdAt must be ${position}, the creation event originalSequence, not its timestamp`);
		}
		for (const ref of [...mutation.evidence, ...mutation.item.sourceRefs, ...mutation.item.exactUserExcerptRefs, ...mutation.item.completionEvidence]) evidence(ref, state, store, inputs, spans);
		if (!mutation.evidence.some(r => r.eventId === mutation.atEventId)) fail("WRITER_INVALID", "Mutation needs evidence at its effective source position");
		if (mutation.item.origin === "explicit_user") {
			if (!mutation.item.exactUserExcerptRefs.length) fail("WRITER_INVALID", "Explicit instruction lacks exact user excerpt");
			for (const ref of mutation.item.exactUserExcerptRefs) {
				const event = evidence(ref, state, store, inputs, spans);
				if (!ref.span || event.authority !== "user" || event.kind !== "user_message") fail("WRITER_INVALID", "Explicit intent needs original user text with a span");
			}
		}
	}
	for (const receipt of page.receipts) {
		object(receipt); string(receipt.eventId); strings(receipt.itemIds, "Receipt.itemIds"); string(receipt.reason);
		oneOf(receipt.classification, ["requirements", "change", "answer", "no_change"]);
		if (!ownedIds.has(receipt.eventId) || state.events.find(e => e.id === receipt.eventId)?.kind !== "user_message") fail("WRITER_INVALID", "Receipt does not refer to an owned user message");
		if (receipt.classification !== "no_change" && !receipt.itemIds.length) fail("WRITER_INVALID", "Receipt omits extracted items");
	}
	unique(page.claims.map(c => c.id)); unique(page.mutations.map(m => `${m.item.id}:${m.item.version}`)); unique(page.receipts.map(r => r.eventId));
	// Quotes are input locators. Keep their exact resolved coordinates in the
	// ledger, without copying source text into every reference. The raw writer
	// response remains immutable in the job attempt artifact.
	for (const ref of [...page.claims.flatMap(c => c.sourceRefs), ...page.mutations.flatMap(m => [...m.evidence, ...m.item.sourceRefs, ...m.item.exactUserExcerptRefs, ...m.item.completionEvidence])]) delete ref.quote;
	return page;
}
export function validateMutation(m: Mutation, previous: WorkItem | undefined, state: SessionState, historicalCorrection = false) {
	const position = state.events.find(e => e.id === m.atEventId)!.originalSequence!;
	const item = m.item;
	if (!historicalCorrection && [...m.evidence, ...item.sourceRefs, ...item.exactUserExcerptRefs, ...item.completionEvidence].some(ref => state.events.find(e => e.id === ref.eventId)!.originalSequence! > position)) fail("WRITER_INVALID", "Mutation cites evidence from a later original position. Emit creation first, then a separate versioned transition at the later evidence event.");
	if (m.expectedVersion !== (previous?.version ?? null) || item.version !== (previous?.version ?? 0) + 1) fail("WRITER_INVALID", "Mutation does not reference the complete current item version");
	if (previous && item.createdAt !== previous.createdAt) fail("WRITER_INVALID", "Item creation position changed");
	if (previous && previous.kind !== item.kind && !(previous.kind === "preference_inference" && previous.origin === "inferred_user" && item.origin === "explicit_user")) fail("WRITER_INVALID", "Changing the work-item kind requires explicit supersession and a new source-linked record");
	if (!previous && !item.id.startsWith(`${m.atEventId}:item:`)) fail("WRITER_INVALID", "New item identity must derive from its owned event");
	if (!previous && item.createdAt !== position) fail("WRITER_INVALID", `New item createdAt must be originalSequence ${position}, not a timestamp`);
	if (item.lastTransition !== position || (!historicalCorrection && previous && position < previous.lastTransition)) fail("WRITER_INVALID", "Out-of-order ledger transition");
	const userEvidence = m.evidence.some(r => { const e = state.events.find(e => e.id === r.eventId); return r.eventId === m.atEventId && e?.authority === "user" && e.kind === "user_message"; });
	if (["cancelled", "superseded"].includes(item.status) && !userEvidence) fail("WRITER_INVALID", "Only user evidence can cancel or supersede instructions");
	if (previous?.origin === "explicit_user" && item.origin !== "explicit_user") fail("WRITER_INVALID", "An explicit instruction cannot be demoted to an inference");
	if (item.origin === "explicit_user" && previous?.origin !== "explicit_user" && !userEvidence) fail("WRITER_INVALID", "Intent promotion lacks user evidence");
	if (item.status === "completed") {
		if (!item.completionEvidence.length) fail("WRITER_INVALID", "Completion lacks outcome evidence");
		if (["constraint", "exclusion"].includes(item.kind)) fail("WRITER_INVALID", "A constraint does not complete with an implementation task");
		const valid = item.completionEvidence.some(r => {
			const event = state.events.find(e => e.id === r.eventId);
			return event?.kind === "tool_result" || event?.kind === "workspace_change" || (item.kind === "question" && event?.kind === "agent_message");
		});
		if (!valid) fail("WRITER_INVALID", "Agent self-report does not verify completion");
	}
}
export function requiresReview(mutation: Mutation, previous?: WorkItem) {
	return !!previous || !OPEN.has(mutation.item.status) || mutation.item.supersedesIds.length > 0;
}
export function replayOperations(ledger: Ledger, events: SourceEvent[]) {
	for (const event of events) {
		if (!event.operationId) continue;
		const current = ledger.operations.find(o => o.id === event.operationId);
		let status = event.operationStatus;
		if (!status && event.kind === "tool_request") status = "unknown";
		if (!status) continue;
		if (!current && event.kind !== "tool_request" && event.kind !== "operation_status") fail("WRITER_INVALID", "Operation result has no recorded dispatch");
		if (current) { current.status = status; current.eventId = event.id; }
		else ledger.operations.push({ id: event.operationId, status, eventId: event.id });
	}
}
export function mergeById<T>(values: T[], key: (value: T) => string): T[] {
	const map = new Map<string, T>();
	for (const value of values) {
		const old = map.get(key(value));
		if (old && canonical(old) !== canonical(value)) fail("WRITER_INVALID", `Conflicting extraction identity ${key(value)}`);
		map.set(key(value), value);
	}
	return [...map.values()];
}
export function annotations(claim: Claim, ledger: Ledger, state: SessionState): string[] {
	const result: string[] = [];
	for (const itemId of claim.itemIds) {
		const canonicalId = ledger.aliases?.find(a => a.aliasId === itemId)?.canonicalId ?? itemId;
		const item = ledger.items.find(i => i.id === canonicalId);
		if (item) result.push(`${itemId}${canonicalId !== itemId ? `, alias of ${canonicalId}` : ""}: ${item.status}, version ${item.version}`);
	}
	if (ledger.claims.some(c => c.invalidatesIds.includes(claim.id))) result.push("invalidated by later evidence");
	if (claim.sourceRefs.some(ref => state.artifacts.find(a => a.id === ref.artifactId)?.captureKind === "workspace_snapshot")) result.push("Host-captured workspace snapshot; not evidence that the main agent inspected its contents");
	if (claim.category === "tested") {
		result.push("Historical test evidence at the stated scope, not a current verification guarantee");
		const observed = Math.max(...claim.sourceRefs.map(r => state.events.find(e => e.id === r.eventId)?.originalSequence ?? 0));
		if (!claim.workspaceVersion || state.events.some(e => (e.kind === "workspace_change" || e.workspaceVersion && e.workspaceVersion !== claim.workspaceVersion) && e.originalSequence! > observed && e.originalSequence! <= ledger.cutoff)) result.push("historical verification only; current validation is stale or unknown");
	}
	return result;
}
