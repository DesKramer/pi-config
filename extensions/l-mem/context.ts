import { CATEGORIES, type Config, type ContextRequest, type Handoff, type HostBinding, type Json, type Ledger, type RenderInput, type Rendered, type SessionState, type SourceEvent, type Store, type Tokenizer, type TrajectoryPlan } from "./contracts.ts";
import { canonical, digest, escapeData, fail, id, json, readJson, saveJson } from "./storage.ts";
import { canonicalItems, currentBlocks, effectiveItems } from "./derived.ts";
import { originalEvents, validateOwnership, validatedWatermark } from "./snapshots.ts";
import { annotations, OPEN } from "./validation.ts";
import { archiveIndex } from "./archive-index.ts";

export { escapeData } from "./storage.ts";
export function jsonRenderer(input: RenderInput, tokenizer: Tokenizer): Rendered {
	const history = "[" + escapeData({ conversationData: "l-mem historical memory", records: input.history }) + ",";
	const trajectory = escapeData({ conversationData: "l-mem trajectory", record: input.trajectory }) + ",";
	const tail = escapeData({ ...(input.controls?.length ? { runtimeControls: input.controls.map(e => ({ eventId: e.event.id, physicalSequence: e.event.sequence, authority: "host, not user authorization", original: e.message })) } : {}), protocolSupport: input.support.map(e => ({ eventId: e.event.id, original: e.message })), originalTail: input.tail.map(e => ({ eventId: e.event.id, original: e.message })) }) + "]";
	const serialized = history + trajectory + tail;
	const counts = { history: tokenizer.count(history), trajectory: tokenizer.count(trajectory), tail: 0, total: tokenizer.count(serialized) };
	// Charge token-boundary effects to the tail. The complete wire serialization is counted once.
	counts.tail = counts.total - counts.history - counts.trajectory;
	return { history, trajectory, tail, payload: JSON.parse(serialized) as Json, counts };
}
export function runtimeControls(state: SessionState): SourceEvent[] {
	// Excluded user-bash output and old compaction summaries are not controls.
	return state.events.filter(e => e.origin === "runtime_control" && e.kind === "agent_message" && e.authority === "host");
}
export function requiredSupport(state: SessionState, tail: SourceEvent[]): SourceEvent[] {
	const ids = new Set(tail.map(e => e.id));
	const support = new Map<string, SourceEvent>();
	for (const event of tail) {
		if (event.kind !== "tool_result" || !event.toolCallId || !event.messageRef) continue;
		const call = state.events.find(e => e.origin === "original" && e.kind === "tool_request" && e.toolCallId === event.toolCallId);
		if (!call) fail("ILLEGAL_TOOL_SEQUENCE", `No original request for tool result ${event.id}`);
		if (!ids.has(call.id)) {
			if (!call.messageRef) fail("ILLEGAL_TOOL_SEQUENCE", `Original request ${call.id} has no protocol-support message`);
			support.set(call.id, call);
		}
	}
	return [...support.values()].sort((a, b) => a.sequence - b.sequence);
}
export function tailFor(state: SessionState, cutoff: number, watermark: number, request: ContextRequest, host: HostBinding) {
	const tail = originalEvents(state).filter(e => e.originalSequence! > cutoff && e.originalSequence! <= watermark);
	for (const eventId of request.unactedUserEventIds) {
		const event = state.events.find(e => e.id === eventId && e.kind === "user_message" && e.origin === "original");
		if (!event || !tail.some(e => e.id === eventId)) fail("REVISION_CONFLICT", "Unacted current user input must remain in the exact tail");
	}
	for (const eventId of request.exactTailEventIds ?? []) if (!tail.some(e => e.id === eventId)) fail("REVISION_CONFLICT", "Current protocol input must remain in the exact tail");
	const initialSupport = requiredSupport(state, tail);
	const support = host.protocolSupport?.(tail, initialSupport) ?? initialSupport;
	const legal = host.validateTail(tail, support);
	if (!legal.ok) fail(legal.code, legal.message);
	return { tail, support };
}
export function availableBudget(request: ContextRequest, config: Config, tokenizer: Tokenizer) {
	for (const value of [request.capacity, request.fixedTokens, request.outputReserve, request.safetyMargin]) if (!Number.isSafeInteger(value) || value < 0) fail("UNSUPPORTED_HOST_CAPABILITY", "Host must supply explicit nonnegative context accounting");
	if (tokenizer.mode === "conservative" && request.safetyMargin <= 0) fail("UNSUPPORTED_HOST_CAPABILITY", "Conservative token counting requires an explicit safety margin");
	return Math.min(config.continuityMax, request.capacity - request.fixedTokens - request.outputReserve - request.safetyMargin);
}
function normalize(text: string, config: Config) { return new Set(text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}_./:-]+/u).filter(t => t.length > 2 && !config.stopWords.includes(t))); }
export function assemble(state: SessionState, store: Store, tokenizer: Tokenizer, host: HostBinding, config: Config, request: ContextRequest, cutoff: number, watermark: number, ledger: Ledger, plan: TrajectoryPlan): Handoff {
	validateOwnership(state);
	if (cutoff < (state.minimumHandoffCutoff ?? 0)) fail("REVISION_CONFLICT", "A historical correction requires a later handoff cutoff");
	if (validatedWatermark(state) < cutoff || ledger.cutoff !== cutoff || plan.cutoff !== cutoff) fail("MEMORY_PENDING", "No contiguous validated memory through cutoff");
	for (const snapshot of state.snapshots.filter(s => s.end <= cutoff)) {
		store.read(state.sessionId, snapshot.manifestRef);
		const block = state.blocks.find(b => b.snapshotId === snapshot.id)!;
		store.read(state.sessionId, block.validationRef);
	}
	const { tail, support } = tailFor(state, cutoff, watermark, request, host);
	const message = (event: SourceEvent) => ({ event, message: event.messageRef ? readJson(store, state.sessionId, event.messageRef) : json({ sourceRole: event.producer, kind: event.kind, content: Buffer.from(store.read(state.sessionId, event.payloadRef)).toString("utf8") }) });
	const exactTail = tail.map(message), protocolSupport = support.map(message), controls = runtimeControls(state).map(event => { store.read(state.sessionId, event.payloadRef); return message(event); });
	const budget = availableBudget(request, config, tokenizer);
	const effective = effectiveItems(ledger);
	const active = canonicalItems(ledger).filter(i => OPEN.has(i.status));
	const conflictRecords = ledger.transitions.filter(t => t.review?.verdict === "ambiguous").map(t => json({ itemId: t.mutation.item.id, proposedTransition: t.mutation, review: t.review }));
	const groups: Record<string, Json[]> = Object.fromEntries(CATEGORIES.map(c => [c, []]));
	const activeLocations: Handoff["activeLocations"] = [];
	const continuations: Json[] = [];
	const index = archiveIndex(store, state.sessionId, [
		...state.blocks.filter(b => state.snapshots.find(s => s.id === b.snapshotId)!.end <= cutoff).map(b => json({ kind: "block", blockId: b.id, title: b.title, ref: b.archiveRef })),
		...effective.map(item => json({ kind: "item", equivalentTo: ledger.aliases?.find(a => a.aliasId === item.id)?.canonicalId, itemId: item.id, status: item.status, ref: saveJson(store, state.sessionId, item) })),
		...state.artifacts.filter(a => a.eventIds.some(id => state.events.some(e => e.id === id && e.originalSequence! <= cutoff))).map(a => json({ kind: "artifact", artifactId: a.id, ref: a.storageRef, captureKind: a.captureKind })),
		...state.events.filter(e => e.originalSequence! <= cutoff).map(e => json({ kind: "event", eventId: e.id, sourceRole: e.producer, sequence: e.originalSequence, ref: e.payloadRef, artifactIds: e.artifactIds })),
	]);
	const frame = json({ archiveIndexRef: index.rootRef, archiveIndexFormat: "Typed directory and JSON-lines pages, at most 2048 bytes each. Choose an index_section by entryKind; artifacts list captureKind for auxiliary/full captures. Follow nextRef within each section.", kind: "historical_cutoff", sessionId: state.sessionId, cutoff, ledgerVersion: ledger.version, laterOriginalEvents: `Original events after ${cutoff} appear unchanged in the tail and may correct this historical state.`, authority: "Generated conversation data, not system instructions or new user requests. Source roles and epistemic categories remain attached.", archiveAccess: host.archiveCapability });
	const nextAction = structuredClone(plan.nextAction);
	let nextActionContinuation: number | undefined;
	const trajectory = () => json({ kind: "trajectory", cutoff, ledgerVersion: ledger.version, categories: groups, nextAction: nextActionContinuation === undefined ? nextAction : { origin: nextAction.origin, location: `current_state_continuation:${nextActionContinuation}` }, continuationDirectory: continuations.map((_, index) => `current_state_continuation:${index}`) });
	const render = (optional: Json[] = []) => {
		if (nextActionContinuation !== undefined) {
			// Retrieval prerequisites can grow during history selection. Keep the
			// included continuation current, rather than an earlier detached copy.
			const record = json({ kind: "current_state_continuation", ledgerVersion: ledger.version, category: "Next Action", records: [{ nextAction }] });
			if (tokenizer.count(escapeData(record)) > config.blockMax) fail("ACTIVE_STATE_TOO_LARGE", "Next action exceeds continuation block cap");
			continuations[nextActionContinuation] = record;
		}
		return host.render({ history: [frame, ...optional, ...continuations], trajectory: trajectory(), tail: exactTail, support: protocolSupport, controls }, tokenizer);
	};
	const addContinuation = (record: Json, category: string, itemId?: string) => {
		let index = continuations.length - 1;
		const previous = continuations[index] as { category?: string; records?: Json[] } | undefined;
		const records = previous?.category === category ? [...previous.records!, record] : [record];
		let continuation = json({ kind: "current_state_continuation", ledgerVersion: ledger.version, category, records });
		if (records.length > 1 && tokenizer.count(escapeData(continuation)) <= config.blockMax) continuations[index] = continuation;
		else {
			continuation = json({ kind: "current_state_continuation", ledgerVersion: ledger.version, category, records: [record] });
			if (tokenizer.count(escapeData(continuation)) > config.blockMax) fail("ACTIVE_STATE_TOO_LARGE", `Operational record ${itemId ?? category} exceeds continuation block cap`);
			index = continuations.length; continuations.push(continuation);
		}
		if (itemId) {
			const existing = activeLocations.find(l => l.itemId === itemId);
			if (existing) existing.location = `current_state_continuation:${index}`;
			else activeLocations.push({ itemId, location: `current_state_continuation:${index}` });
		}
		return index;
	};
	const addMandatory = (record: Json, category: string, itemId?: string) => {
		groups[category].push(record);
		if (render().counts.trajectory <= config.trajectoryMax) {
			if (itemId) activeLocations.push({ itemId, location: `trajectory:${category}:${groups[category].length - 1}` });
			return;
		}
		groups[category].pop();
		addContinuation(record, category, itemId);
	};
	for (const item of active) {
		const entry = plan.entries.find(e => e.itemId === item.id);
		if (!entry) fail("WRITER_INVALID", "Trajectory mapping omitted an active obligation");
		const excerpts = item.exactUserExcerptRefs.map(ref => {
			const event = state.events.find(e => e.id === ref.eventId)!;
			const artifact = state.artifacts.find(a => a.id === (ref.artifactId ?? event.artifactIds[0]));
			if (!artifact) fail("MISSING_ARTIFACT", "Exact user wording is unavailable");
			const bytes = store.read(state.sessionId, artifact.storageRef);
			return { ref, originalRef: artifact.storageRef, text: Buffer.from(ref.span ? bytes.slice(ref.span.start, ref.span.end) : bytes).toString("utf8") };
		});
		// A compact deterministic view removes duplicate evidence fields and empty
		// bookkeeping, not wording, conditions, scope, status or dependencies.
		const equivalent = ledger.aliases?.filter(a => a.canonicalId === item.id) ?? [];
		const compact = json({ id: item.id, ...(equivalent.length ? { aliasIds: equivalent.map(a => a.aliasId), equivalenceRef: saveJson(store, state.sessionId, equivalent) } : {}), kind: item.kind, statement: item.statement, origin: item.origin, scope: item.scope, status: item.status,
			conditions: item.conditions, dependencies: item.dependencies.map(id => { const dependency = effective.find(i => i.id === id)!; return { id, statement: dependency.statement, status: dependency.status }; }),
			...(item.parentId ? { parentId: item.parentId } : {}), ...(item.deferralReason ? { deferralReason: item.deferralReason } : {}), ...(item.inferenceBasis ? { inferenceBasis: item.inferenceBasis } : {}),
			...(item.conflicts.length ? { conflicts: item.conflicts } : {}),
			sourceRefs: item.sourceRefs.map(ref => ({ eventId: ref.eventId, artifactId: ref.artifactId, span: ref.span, observationScope: ref.observationScope })),
			exactUserExcerpts: excerpts.map(({ ref, originalRef, text }) => ({ eventId: ref.eventId, artifactId: ref.artifactId, span: ref.span, originalRef, text })),
		});
		addMandatory(compact, entry.category, item.id);
	}
	for (const operation of ledger.operations.filter(o => o.status === "running" || o.status === "unknown")) addMandatory(json({ operation, nextInspection: "Inspect this existing operation through the host. Do not dispatch it again to recover an output." }), "Blockers");
	for (const conflict of conflictRecords) addMandatory(conflict, "Blockers");
	for (const conflict of plan.conflictIds) addMandatory(json({ unresolvedConflict: conflict }), "Blockers");
	// Both operational items and the complete proposed next action can move to
	// included history continuations. Neither becomes retrieval-only state.
	const rebalanceTrajectory = (optional: Json[] = []) => {
		while (render(optional).counts.trajectory > config.trajectoryMax) {
			const category = [...CATEGORIES].reverse().find(c => groups[c].length);
			if (!category) {
				if (nextActionContinuation !== undefined) fail("ACTIVE_STATE_TOO_LARGE", "Trajectory framing and continuation directory exceed the trajectory cap");
				nextActionContinuation = addContinuation(json({ nextAction }), "Next Action");
				continue;
			}
			const record = groups[category].pop()!;
			const itemId = record && typeof record === "object" && !Array.isArray(record) && typeof record.id === "string" ? record.id : undefined;
			addContinuation(record, category, itemId);
		}
	};
	rebalanceTrajectory();
	// Completed work remains optional history; selected claims carry verification annotations.
	let rendered = render();
	function checkMandatory() {
		const c = rendered.counts;
		if (c.trajectory > config.trajectoryMax || c.history > config.historyMax || c.total > budget) fail(active.length || continuations.length ? "ACTIVE_STATE_TOO_LARGE" : "CONTEXT_BUDGET_EXCEEDED", `Mandatory continuity needs H=${c.history}, T=${c.trajectory}, R=${c.tail}; available total=${budget}`);
	}
	checkMandatory();
	const optionalProgress: Json[] = [];
	for (const claim of ledger.claims.filter(c => ["changed", "tested", "completed"].includes(c.category)).slice(-3)) {
		try {
			for (const ref of claim.sourceRefs) {
				const event = state.events.find(e => e.id === ref.eventId);
				const artifact = state.artifacts.find(a => a.id === (ref.artifactId ?? event?.artifactIds[0]));
				if (!artifact) fail("MISSING_ARTIFACT", "Optional progress evidence is unavailable");
				store.read(state.sessionId, artifact.storageRef);
			}
		} catch { continue; }
		const record = json({ historicalProgress: claim, currentStatus: annotations(claim, ledger, state) });
		groups.Progress.push(record);
		const trial = render();
		if (trial.counts.trajectory <= config.trajectoryMax && trial.counts.total <= budget) optionalProgress.push(record);
		else groups.Progress.pop();
	}
	const eligible = currentBlocks(state).filter(b => state.snapshots.find(s => s.id === b.snapshotId)!.end <= cutoff);
	const activeIds = new Set(active.map(i => i.id));
	const requiredIds = new Set([...plan.requiredBlockIds, ...nextAction.evidenceBlockIds]);
	const recent = new Set(eligible.filter(b => !requiredIds.has(b.id)).slice(-3).map(b => b.id));
	const query = `${active.map(i => i.statement + " " + i.scope).join(" ")} ${nextAction.text}`;
	const terms = normalize(query, config);
	const entities = new Set(ledger.claims.filter(c => c.itemIds.some(i => activeIds.has(i))).flatMap(c => c.entities));
	const candidates = eligible.map((block, index) => {
		const claims = ledger.claims.filter(c => block.claimIds.includes(c.id));
		const itemMatches = new Set(claims.flatMap(c => c.itemIds).filter(i => activeIds.has(i))).size;
		const entityMatches = new Set(claims.flatMap(c => c.entities).filter(e => entities.has(e))).size;
		const blockTerms = normalize(`${block.title} ${claims.map(c => c.text).join(" ")}`, config);
		const termMatches = [...blockTerms].filter(t => terms.has(t)).length;
		const recency = Math.max(0, index - Math.max(0, eligible.length - 10) + 1);
		const tier = requiredIds.has(block.id) ? 2 : recent.has(block.id) ? 3 : 4;
		const score = 100 * itemMatches + 20 * entityMatches + Math.min(50, 5 * termMatches) + recency;
		return { block, claims, tier, score, cutoff: state.snapshots.find(s => s.id === block.snapshotId)!.end };
	}).filter(c => c.tier < 4 || c.score > 10).sort((a, b) => a.tier - b.tier || b.score - a.score || b.cutoff - a.cutoff || a.block.id.localeCompare(b.block.id));
	const selected: typeof candidates = [];
	const annotationsList: Json[] = [];
	const renderBlocks = (list: typeof candidates) => list.slice().sort((a, b) => a.cutoff - b.cutoff || a.block.id.localeCompare(b.block.id)).map(c => json({ block: c.block.content, archiveRef: c.block.archiveRef, currentStatus: c.claims.map(claim => ({ claimId: claim.id, annotations: annotations(claim, ledger, state) })) }));
	for (const candidate of candidates) {
		if (tokenizer.count(escapeData(renderBlocks([candidate])[0])) > config.blockMax) continue;
		try {
			store.read(state.sessionId, candidate.block.archiveRef);
			for (const ref of candidate.claims.flatMap(c => c.sourceRefs)) {
				const event = state.events.find(e => e.id === ref.eventId);
				const artifact = state.artifacts.find(a => a.id === (ref.artifactId ?? event?.artifactIds[0]));
				if (!artifact) fail("MISSING_ARTIFACT", `Unavailable historical evidence ${ref.eventId}`);
				store.read(state.sessionId, artifact.storageRef);
			}
		}
		catch { if (requiredIds.has(candidate.block.id)) fail("MISSING_ARTIFACT", `Required block unavailable: ${candidate.block.id}`); continue; }
		const trial = render(renderBlocks([...selected, candidate]));
		if (trial.counts.history <= config.historyMax && trial.counts.total <= budget && trial.counts.trajectory <= config.trajectoryMax) selected.push(candidate);
	}
	const selectedIds = new Set(selected.map(c => c.block.id));
	for (const required of requiredIds) {
		if (!selectedIds.has(required)) {
			const block = eligible.find(b => b.id === required);
			if (!block) fail("WRITER_INVALID", "Dependent action cites a block outside cutoff");
			store.read(state.sessionId, block.archiveRef);
			for (const ref of ledger.claims.filter(c => block.claimIds.includes(c.id)).flatMap(c => c.sourceRefs)) {
				const event = state.events.find(e => e.id === ref.eventId);
				const artifact = state.artifacts.find(a => a.id === (ref.artifactId ?? event?.artifactIds[0]));
				if (!artifact) fail("MISSING_ARTIFACT", `Required omitted evidence is unavailable: ${ref.eventId}`);
				store.read(state.sessionId, artifact.storageRef);
			}
			nextAction.retrievalPrerequisites.push(`Before the dependent action, read ${block.archiveRef} using the archive access described in the history frame.`);
		}
	}
	// New prerequisites can change both partitions. Drop optional material and
	// rebalance until every mandatory record is included or capacity is refused.
	rendered = render(renderBlocks(selected));
	const dropProgress = () => { const record = optionalProgress.pop()!; groups.Progress.splice(groups.Progress.indexOf(record), 1); };
	for (;;) {
		if (rendered.counts.trajectory > config.trajectoryMax) {
			if (optionalProgress.length) dropProgress(); else rebalanceTrajectory(renderBlocks(selected));
		} else if (selected.length && (rendered.counts.total > budget || rendered.counts.history > config.historyMax)) {
			const removed = selected.pop()!;
			if (requiredIds.has(removed.block.id)) nextAction.retrievalPrerequisites.push(`Before the dependent action, read ${removed.block.archiveRef} using the archive access described in the history frame.`);
		} else if (optionalProgress.length && rendered.counts.total > budget) dropProgress();
		else break;
		rendered = render(renderBlocks(selected));
	}
	checkMandatory();
	if (rendered.counts.total !== rendered.counts.history + rendered.counts.trajectory + rendered.counts.tail || Object.values(rendered.counts).some(n => !Number.isSafeInteger(n) || n < 0)) fail("UNSUPPORTED_HOST_CAPABILITY", "Renderer must supply inclusive, non-overlapping partition counts");
	for (const candidate of selected) for (const claim of candidate.claims) annotationsList.push(json({ blockId: candidate.block.id, claimId: claim.id, status: annotations(claim, ledger, state) }));
	// Resolve every event/artifact reference used in context before publishing a manifest.
	for (const item of active) for (const ref of [...item.sourceRefs, ...item.exactUserExcerptRefs, ...item.completionEvidence]) {
		const event = state.events.find(e => e.id === ref.eventId)!;
		const artifact = state.artifacts.find(a => a.id === (ref.artifactId ?? event?.artifactIds[0]));
		if (!artifact) fail("MISSING_ARTIFACT", `Missing active evidence ${ref.eventId}`);
		store.read(state.sessionId, artifact.storageRef);
	}
	for (const event of [...tail, ...support]) { store.read(state.sessionId, event.payloadRef); if (event.messageRef) store.read(state.sessionId, event.messageRef); }
	for (const alias of ledger.aliases ?? []) {
		const location = activeLocations.find(l => l.itemId === alias.canonicalId);
		if (location) activeLocations.push({ ...location, itemId: alias.aliasId });
		for (const ref of [...alias.evidence, ...alias.review.evidence]) {
			const event = state.events.find(e => e.id === ref.eventId)!;
			const artifact = state.artifacts.find(a => a.id === (ref.artifactId ?? event?.artifactIds[0]));
			if (!artifact) fail("MISSING_ARTIFACT", "Alias equivalence evidence is missing");
			store.read(state.sessionId, artifact.storageRef);
		}
	}
	const payloadRef = saveJson(store, state.sessionId, rendered);
	const validationRef = saveJson(store, state.sessionId, { checked: ["contiguous_coverage", "active_ids_and_operational_fields", "exact_tail", "tool_protocol", "archive_refs", "inclusive_tokens"], cutoff, watermark, activeLocations, counts: rendered.counts, semanticAccuracy: "requires behavioral evaluation" });
	const manifest: Handoff = {
		id: id("h", state.sessionId, request, cutoff, watermark, ledger.version, rendered, config, host.version, tokenizer.id), sessionId: state.sessionId,
		request, cutoff, watermark, ledgerVersion: ledger.version, snapshotIds: state.snapshots.filter(s => s.end <= cutoff).map(s => s.id),
		selectedBlocks: selected.map(c => ({ id: c.block.id, tier: c.tier, score: c.score, reason: c.tier === 2 ? "explicit next-action/blocker/conflict evidence" : c.tier === 3 ? "three most recent eligible blocks" : "exact entities, active IDs, normalized terms and recency" })),
		omittedBlockIds: eligible.filter(b => !selected.some(s => s.block.id === b.id)).map(b => b.id), annotations: annotationsList,
		continuations, trajectory: trajectory(), activeLocations, tailEventIds: tail.map(e => e.id), supportEventIds: support.map(e => e.id), controlEventIds: controls.map(e => e.event.id),
		indexRefs: index.refs, rendered, renderInput: { history: [frame, ...renderBlocks(selected), ...continuations], trajectory: trajectory(), tail: exactTail, support: protocolSupport, controls }, payloadRef, validationRef, configuration: config, tokenizerId: tokenizer.id, hostVersion: host.version, state: "prepared", derivedRevision: state.derivedRevision ?? 0,
	};
	return manifest;
}

/** Activation only extends the original tail. Validated historical data and plans
 * stay immutable; no selection, archive-index rewrite or model call runs here.
 */
export function refreshHandoff(state: SessionState, store: Store, tokenizer: Tokenizer, host: HostBinding, handoff: Handoff): Handoff {
	const watermark = originalEvents(state).length;
	store.read(state.sessionId, handoff.payloadRef);
	for (const ref of handoff.indexRefs ?? []) store.read(state.sessionId, ref);
	const controls = runtimeControls(state).map(event => {
		store.read(state.sessionId, event.payloadRef);
		return { event, message: event.messageRef ? readJson(store, state.sessionId, event.messageRef) : json({ sourceRole: "host", content: Buffer.from(store.read(state.sessionId, event.payloadRef)).toString("utf8") }) };
	});
	if (watermark === handoff.watermark && canonical(controls.map(e => e.event.id)) === canonical(handoff.controlEventIds ?? [])) return handoff;
	if (watermark < handoff.watermark) fail("REVISION_CONFLICT", "Source history moved behind the prepared watermark");
	const { tail, support } = tailFor(state, handoff.cutoff, watermark, handoff.request, host);
	const message = (event: SourceEvent) => ({ event, message: event.messageRef ? readJson(store, state.sessionId, event.messageRef) : json({ sourceRole: event.producer, kind: event.kind, content: Buffer.from(store.read(state.sessionId, event.payloadRef)).toString("utf8") }) });
	const renderInput = { ...handoff.renderInput, tail: tail.map(message), support: support.map(message), controls };
	const rendered = host.render(renderInput, tokenizer);
	const counts = rendered.counts, config = handoff.configuration;
	if (counts.total !== counts.history + counts.trajectory + counts.tail || Object.values(counts).some(n => !Number.isSafeInteger(n) || n < 0)) fail("UNSUPPORTED_HOST_CAPABILITY", "Invalid inclusive token counts during activation");
	if (counts.history > config.historyMax || counts.trajectory > config.trajectoryMax || counts.total > availableBudget(handoff.request, config, tokenizer)) fail("CONTEXT_BUDGET_EXCEEDED", "New original events do not fit the prepared handoff; release the barrier and prepare a later cutoff");
	return { ...handoff, id: id("h", handoff.id, watermark, rendered), watermark, renderInput, rendered,
		tailEventIds: tail.map(e => e.id), supportEventIds: support.map(e => e.id), controlEventIds: controls.map(e => e.event.id),
		payloadRef: saveJson(store, state.sessionId, rendered),
		validationRef: saveJson(store, state.sessionId, { priorValidationRef: handoff.validationRef, priorHandoffId: handoff.id, watermark, checked: ["exact_tail_extension", "tool_protocol", "inclusive_tokens"], counts }),
	};
}
