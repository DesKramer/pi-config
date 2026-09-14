import type { Block, Config, DerivedUpdate, Json, Ledger, Review, SessionState, Store, Tokenizer, WorkItem } from "./contracts.ts";
import { canonical, digest, escapeData, fail, id, json, readJson, saveJson, update } from "./storage.ts";
import { array, evidence, object, oneOf, string, strings, unique, validateMutation, validatePage } from "./validation.ts";
import { validateOwnership } from "./snapshots.ts";
import { PROMPT_VERSIONS } from "./prompts.ts";

export function currentBlocks(state: SessionState): Block[] {
	const replaced = new Set(state.blocks.flatMap(b => b.supersedesBlockVersion ? [b.supersedesBlockVersion] : []));
	return state.blocks.filter(b => !replaced.has(b.id));
}
export function effectiveItems(ledger: Ledger): WorkItem[] {
	return ledger.items.map(item => {
		let target = item; const seen = new Set<string>();
		for (;;) {
			const alias = ledger.aliases?.find(a => a.aliasId === target.id);
			if (!alias) break;
			if (seen.has(target.id)) fail("STORAGE_ERROR", "Cyclic alias graph");
			seen.add(target.id);
			target = ledger.items.find(i => i.id === alias.canonicalId)!;
			if (!target) fail("STORAGE_ERROR", "Alias target is missing");
		}
		// An alias is an evidence-backed identity projection, not a replayed
		// transition. Preserve the original record and expose current target status.
		return target === item ? item : { ...target, id: item.id, version: item.version, createdAt: item.createdAt, sourceRefs: [...new Map([...item.sourceRefs, ...target.sourceRefs].map(ref => [canonical(ref), ref])).values()] };
	});
}
export function canonicalItems(ledger: Ledger): WorkItem[] { return ledger.items.filter(i => !ledger.aliases?.some(a => a.aliasId === i.id)); }
export type DerivedJob = <T>(kind: "block" | "reviewer", input: Json, validate: (output: Json) => T, readable?: ReadonlySet<string>) => Promise<T>;
export async function derive(store: Store, sessionId: string, tokenizer: Tokenizer, config: Config, modelIdentity: string, request: DerivedUpdate, job: DerivedJob): Promise<string> {
	request = structuredClone(request);
	const before = store.load(sessionId).state;
	validateOwnership(before);
	if (!request || !["regenerate_block", "reconcile"].includes(request.kind)) fail("INVALID_EVENT", "Unknown derived update");
	const inputDigest = digest({ request, tokenizer: tokenizer.id, config, modelIdentity, prompts: PROMPT_VERSIONS });
	const replay = before.derivedUpdates?.find(r => r.inputDigest === inputDigest);
	if (replay) return replay.resultId;
	if (request.kind === "regenerate_block") {
		const old = currentBlocks(before).find(b => b.id === request.blockId);
		if (!old) fail("REVISION_CONFLICT", "Regenerate the current block version, not an absent or superseded version");
		const snapshot = before.snapshots.find(s => s.id === old.snapshotId)!;
		store.read(sessionId, snapshot.manifestRef);
		for (const event of before.events.filter(e => snapshot.eventIds.includes(e.id))) store.read(sessionId, event.payloadRef);
		const extraction = before.extractions.find(e => e.snapshotId === old.snapshotId)!;
		const claims = extraction.pages.flatMap(p => p.claims);
		const selected: string[] = []; let title = old.title;
		const groups: typeof claims[] = []; let group: typeof claims = [];
		for (const claim of claims) {
			if (group.length && tokenizer.count(canonical([...group, claim])) > config.writerInputMax / 2) { groups.push(group); group = []; }
			group.push(claim);
		}
		if (group.length) groups.push(group);
		for (const claims of groups) {
			const result = await job("block", json({ snapshotId: snapshot.id, supersedesBlockVersion: old.id, claims, tokenLimit: config.blockPreferred }), value => {
				object(value); string(value.title); strings(value.claimIds); unique(value.claimIds);
				if (value.claimIds.some(id => !claims.some(c => c.id === id))) fail("WRITER_INVALID", "Regeneration invented a claim");
				return { title: value.title, claimIds: value.claimIds };
			});
			title = result.title; selected.push(...result.claimIds);
		}
		const included: typeof claims = [];
		const content = () => json({ kind: "historical_snapshot", snapshotId: snapshot.id, cutoff: snapshot.end, title, claims: included });
		if (tokenizer.count(escapeData(content())) > config.blockMax) fail("WRITER_INVALID", "Regenerated title exceeds block cap");
		for (const id of [...new Set(selected)]) { included.push(claims.find(c => c.id === id)!); if (tokenizer.count(escapeData(content())) > config.blockMax) included.pop(); }
		const rendered = escapeData(content());
		const generationJobIds = store.load(sessionId).state.jobs.filter(j => j.kind === "block" && j.state === "complete" && (readJson(store, sessionId, j.inputRef) as any).input?.supersedesBlockVersion === old.id).map(j => j.id);
		const block: Block = { ...old, id: id("b", old.id, inputDigest, rendered), title, claimIds: included.map(c => c.id), content: content(), rendered, tokens: tokenizer.count(rendered), tokenizerId: tokenizer.id,
			modelIdentity, jobId: generationJobIds.at(-1) ?? old.jobId, writerPromptVersion: PROMPT_VERSIONS.block, supersedesBlockVersion: old.id,
			archiveRef: saveJson(store, sessionId, content()), validationRef: saveJson(store, sessionId, { version: 1, supersedesBlockVersion: old.id, sourceDigest: snapshot.sourceDigest, ledgerUnchanged: true, extractionUnchanged: true, generationJobIds, inputDigest }) };
		update(store, sessionId, state => {
			if (state.derivedUpdates?.some(r => r.inputDigest === inputDigest)) return;
			if (!currentBlocks(state).some(b => b.id === old.id)) fail("REVISION_CONFLICT", "Block changed during regeneration");
			state.blocks.push(block); state.derivedRevision = (state.derivedRevision ?? 0) + 1;
			(state.derivedUpdates ??= []).push({ inputDigest, kind: request.kind, resultId: block.id });
		});
		return block.id;
	}
	if (request.kind !== "reconcile") fail("INVALID_EVENT", "Unknown derived update");
	const prior = before.ledgers.at(-1);
	if (!prior || prior.version !== request.expectedLedgerVersion) fail("REVISION_CONFLICT", "Reconciliation needs the complete current ledger version");
	array(request.mutations); array(request.aliases); string(request.requestId);
	const declared = new Set(before.events.filter(e => e.originalSequence! <= prior.cutoff).map(e => e.id));
	const effective = new Set(request.mutations.map(m => m.atEventId));
	const page = validatePage({ schemaVersion: 1, claims: [], mutations: request.mutations, receipts: [], complete: true, nextCursor: null }, before, store, effective, declared, new Map());
	const ledger = structuredClone(prior), reconciliationVersion = id("reconciliation", prior.version, inputDigest);
	const sourceRefs = before.events.filter(e => declared.has(e.id)).map(e => ({ eventId: e.id, authority: e.authority, originalSequence: e.originalSequence, ref: e.payloadRef }));
	const sourceDirectoryRef = store.put(sessionId, Buffer.from(sourceRefs.map(canonical).join("\n")), "txt");
	const readable = new Set([sourceDirectoryRef, ...sourceRefs.map(r => r.ref)]);
	const review = async (proposal: unknown, refs: import("./contracts.ts").EvidenceRef[]): Promise<Review> => {
		const originalExcerpts = refs.map(ref => {
			const event = evidence(ref, before, store, declared);
			const artifact = before.artifacts.find(a => a.id === (ref.artifactId ?? event.artifactIds[0]))!;
			const bytes = store.read(sessionId, artifact.storageRef);
			return { ref, authority: event.authority, kind: event.kind, originalSequence: event.originalSequence, observationScope: event.observationScope, text: Buffer.from(ref.span ? bytes.slice(ref.span.start, ref.span.end) : bytes).toString("utf8") };
		});
		return job("reviewer", json({ historicalReconciliation: true, reconciliationVersion, sourceCutoff: prior.cutoff, proposal, originalExcerpts, sourceDirectoryRef,
			instruction: "Compare this correction or identity-equivalence proposal against all relevant intervening original sources. Do not revive work validly cancelled later. Equivalence must preserve authority, scope, conditions and completion criteria, not just similar wording. Return only a verdict; never invent a replacement transition." }), value => {
			value = structuredClone(value);
			object(value); oneOf(value.verdict, ["supported", "unsupported", "ambiguous"]); string(value.explanation); array(value.evidence);
			const result = value as unknown as Review;
			if (!result.evidence.length) fail("WRITER_INVALID", "Reconciliation review omitted evidence");
			for (const ref of result.evidence) { evidence(ref, before, store, declared); if (!ref.span) fail("WRITER_INVALID", "Reconciliation requires exact original evidence"); }
			return result;
		}, readable);
	};
	for (const mutation of page.mutations) {
		const previous = ledger.items.find(i => i.id === mutation.item.id);
		if (ledger.aliases?.some(a => a.aliasId === mutation.item.id)) fail("WRITER_INVALID", "Mutate an alias's canonical ID instead");
		validateMutation(mutation, previous, before, true);
		const verdict = await review({ previous: previous ?? null, mutation, interveningTransitions: ledger.transitions.filter(t => t.mutation.item.id === mutation.item.id) }, [...mutation.evidence, ...(previous?.sourceRefs ?? [])]);
		ledger.transitions.push({ mutation, accepted: verdict.verdict === "supported", review: verdict, reason: `Reconciliation ${reconciliationVersion}; effective source ${mutation.item.lastTransition}; applied through ${prior.cutoff}` });
		if (verdict.verdict === "supported") {
			if (previous) ledger.items[ledger.items.indexOf(previous)] = mutation.item; else ledger.items.push(mutation.item);
		}
	}
	for (const proposal of request.aliases) {
		const alias = ledger.items.find(i => i.id === proposal.aliasId), target = ledger.items.find(i => i.id === proposal.canonicalId);
		if (!alias || !target || alias === target || ledger.aliases?.some(a => a.aliasId === alias.id || a.aliasId === target.id || a.canonicalId === alias.id)) fail("WRITER_INVALID", "Alias must join two existing canonical identities without cycles");
		if (alias.origin !== target.origin || alias.kind !== target.kind || alias.status !== target.status || canonical(alias.conditions) !== canonical(target.conditions) || canonical(alias.dependencies) !== canonical(target.dependencies)) fail("WRITER_INVALID", "An alias cannot promote authority, change status or discard conditions/dependencies");
		const verdict = await review({ alias, canonical: target, proposedEquivalence: proposal }, [...proposal.evidence, ...alias.sourceRefs, ...target.sourceRefs]);
		if (verdict.verdict === "supported") (ledger.aliases ??= []).push({ ...proposal, review: verdict, reconciliationVersion });
	}
	for (const item of ledger.items) for (const related of [...item.dependencies, ...item.supersedesIds, ...item.supersededByIds, ...(item.parentId ? [item.parentId] : [])]) if (!ledger.items.some(i => i.id === related)) fail("WRITER_INVALID", "Correction contains an unresolved item relationship");
	ledger.reconciliation = { version: reconciliationVersion, previousLedgerVersion: prior.version, effectivePositions: [...effective].map(id => before.events.find(e => e.id === id)!.originalSequence!), reconciledThrough: prior.cutoff };
	ledger.version = id("l", reconciliationVersion, ledger);
	update(store, sessionId, state => {
		if (state.derivedUpdates?.some(r => r.inputDigest === inputDigest)) return;
		if (state.ledgers.at(-1)?.version !== prior.version) fail("REVISION_CONFLICT", "Ledger changed while reconciliation was reviewed");
		state.ledgers.push(ledger); state.derivedRevision = (state.derivedRevision ?? 0) + 1;
		// Earlier views remain readable, but a future handoff cannot knowingly use
		// the uncorrected view. No old source transition is replayed to rebuild it.
		state.minimumHandoffCutoff = Math.max(state.minimumHandoffCutoff ?? 0, prior.cutoff);
		(state.derivedUpdates ??= []).push({ inputDigest, kind: request.kind, resultId: ledger.version });
	});
	return ledger.version;
}
