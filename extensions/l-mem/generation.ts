import type { Block, Config, ExtractionPage, Job, Json, Ledger, ModelBinding, Review, SessionState, Snapshot, Store, Tokenizer, TrajectoryPlan } from "./contracts.ts";
import { CATEGORIES } from "./contracts.ts";
import { MemoryError, canonical, digest, fail, id, json, readJson, saveJson, update } from "./storage.ts";
import { BLOCK_PROMPT, PROMPT_VERSIONS, REVIEWER_PROMPT, TRAJECTORY_PROMPT, WRITER_PROMPT } from "./prompts.ts";
import { originalEvents, textSegments, validatedWatermark } from "./snapshots.ts";
import { escapeData } from "./context.ts";
import { canonicalItems, derive, effectiveItems } from "./derived.ts";
import type { DerivedUpdate } from "./contracts.ts";
import { annotations, array, evidence, mergeById, object, oneOf, OPEN, replayOperations, requiresReview, string, strings, unique, validateMutation, validatePage } from "./validation.ts";

class ExhaustedJob extends MemoryError { constructor(message: string) { super("WRITER_INVALID", message); } }
const PROMPTS = { writer: WRITER_PROMPT, reviewer: REVIEWER_PROMPT, block: BLOCK_PROMPT, trajectory: TRAJECTORY_PROMPT };
export class Generation {
	readonly store: Store;
	readonly tokenizer: Tokenizer;
	readonly model: ModelBinding;
	readonly config: Config;
	readonly now: () => number;
	constructor(store: Store, tokenizer: Tokenizer, model: ModelBinding, config: Config, now: () => number) {
		this.store = store; this.tokenizer = tokenizer; this.model = model; this.config = config; this.now = now;
	}
	async job<T>(sessionId: string, kind: Job["kind"], input: Json, validate: (value: Json) => T, readableRefs: ReadonlySet<string> = new Set()): Promise<T> {
		const prompt = PROMPTS[kind];
		if (this.tokenizer.count(canonical({ prompt, input })) > this.config.writerInputMax) fail("CONTEXT_BUDGET_EXCEEDED", `Bounded ${kind} input exceeds writer allocation`);
		const inputDigest = digest({ input, prompt, model: this.model.identity, tokenizer: this.tokenizer.id, config: this.config });
		const jobId = id("j", sessionId, kind, inputDigest);
		const prior = this.store.load(sessionId).state.jobs.find(j => j.id === jobId);
		if (prior?.state === "complete") return validate(prior.output!);
		if (prior?.state === "running" && prior.leaseUntil > this.now()) fail("MEMORY_PENDING", `Job ${jobId} is running`);
		if (prior?.state === "invalid" && prior.attempts.length > this.config.repairs) throw new ExhaustedJob(`Job ${jobId} exhausted repairs: ${prior.attempts.at(-1)?.error}`);
		const lease = this.now() + this.config.jobTimeoutMs * (this.config.repairs + 1) + 1000;
		update(this.store, sessionId, state => {
			const existing = state.jobs.find(j => j.id === jobId);
			if (existing?.state === "complete" || (existing?.state === "running" && existing.leaseUntil > this.now())) fail("MEMORY_PENDING", `Job ${jobId} is owned by another generation stream`);
			if (existing) { existing.state = "running"; existing.leaseUntil = lease; }
			else state.jobs.push({ id: jobId, kind, inputDigest, inputRef: saveJson(this.store, sessionId, { prompt, input }), promptVersion: PROMPT_VERSIONS[kind], modelIdentity: this.model.identity, tokenizerId: this.tokenizer.id, state: "running", leaseUntil: lease, attempts: [] });
		});
		let errors = prior?.attempts.at(-1)?.error ?? "";
		for (let attempt = prior?.attempts.length ?? 0; attempt <= this.config.repairs; attempt++) {
			const startedAt = this.now(), controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			let output: Json | undefined;
			let inputTokens = 0, outputTokens = 0;
			const providerUsage: Json[] = [];
			try {
				const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Memory model job timed out")); }, this.config.jobTimeoutMs); });
				const readLimits = { maxTokens: Math.floor(this.config.writerInputMax / 4) };
				const outputLimits = { counting: this.tokenizer.id, maxCountedUnits: this.config.writerOutputMax, suggestedJsonBytes: Math.floor(this.config.writerOutputMax / 2), pagination: "For writer jobs, use complete:false and nextCursor rather than omit records or exceed the allocation." };
				let jobInput = json({ source: input, validationErrors: errors, readLimits, outputLimits });
				const memoryReads: Json[] = [];
				for (let reads = 0; ; reads++) {
					if (this.tokenizer.count(canonical({ prompt, input: jobInput })) > this.config.writerInputMax) fail("WRITER_INVALID", "Repair or lookup input exceeds writer allocation");
					inputTokens += this.tokenizer.count(canonical({ prompt, input: jobInput }));
					const callId = crypto.randomUUID();
					output = await Promise.race([this.model.invoke({ kind, prompt, input: jobInput, maxOutputTokens: this.config.writerOutputMax, signal: controller.signal, onUsage: usage => providerUsage.push(json(usage)), onResponse: response => {
						const responseRef = saveJson(this.store, sessionId, response);
						update(this.store, sessionId, state => {
							const job = state.jobs.find(j => j.id === jobId);
							if (!job) fail("REVISION_CONFLICT", "Response has no generation job");
							const prior = job.responses?.find(r => r.callId === callId);
							if (prior && prior.responseRef !== responseRef) fail("DUPLICATE_EVENT_CONFLICT", "A model call returned conflicting terminal responses");
							if (!prior) (job.responses ??= []).push({ callId, attempt, receivedAt: this.now(), responseRef });
						});
					} }), timeout]);
					outputTokens += this.tokenizer.count(canonical(output));
					if (this.tokenizer.count(canonical(output)) > this.config.writerOutputMax) fail("WRITER_INVALID", "Writer output exceeds bounded job allocation");
					object(output);
					if (!("read" in output)) break;
					if (reads >= this.config.writerPageMax) fail("WRITER_INVALID", "Memory read limit exceeded");
					object(output.read); string(output.read.ref);
					if (!readableRefs.has(output.read.ref)) fail("WRITER_INVALID", "Writer requested an undeclared archive reference");
					const offset = output.read.offset ?? 0;
					if (!Number.isSafeInteger(offset) || (offset as number) < 0) fail("WRITER_INVALID", "Invalid memory read offset");
					const bytes = this.store.read(sessionId, output.read.ref);
					if ((offset as number) > bytes.length) fail("WRITER_INVALID", "Memory read offset is beyond artifact");
					const limit = output.read.limit ?? Math.floor(this.config.writerInputMax / 4);
					if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > this.config.writerInputMax / 4) fail("WRITER_INVALID", "Memory read limit is outside the bounded allocation");
					const part = textSegments(bytes.slice(offset as number), limit as number, this.tokenizer)[0];
					const memoryRead = json({ ref: output.read.ref, offset, text: part.text, nextOffset: (offset as number) + part.end < bytes.length ? (offset as number) + part.end : null });
					memoryReads.push(memoryRead);
					jobInput = json({ source: input, validationErrors: errors, readLimits, outputLimits, memoryRead, memoryReads });
				}
				const result = validate(output);
				update(this.store, sessionId, state => {
					const job = state.jobs.find(j => j.id === jobId)!;
					if (job.leaseUntil !== lease || job.state !== "running") fail("REVISION_CONFLICT", "Generation lease changed");
					job.attempts.push({ startedAt, durationMs: this.now() - startedAt, outputRef: saveJson(this.store, sessionId, output), tokens: outputTokens, inputTokens, providerUsage });
					job.output = output; job.state = "complete";
				});
				return result;
			} catch (error) {
				errors = error instanceof Error ? error.message : String(error);
				update(this.store, sessionId, state => {
					const job = state.jobs.find(j => j.id === jobId)!;
					if (job.leaseUntil !== lease || job.state !== "running") fail("REVISION_CONFLICT", "Generation lease changed after failed attempt");
					job.attempts.push({ startedAt, durationMs: this.now() - startedAt, error: errors, tokens: outputTokens, inputTokens, providerUsage, ...(output !== undefined ? { outputRef: saveJson(this.store, sessionId, output) } : {}) });
					if (attempt === this.config.repairs) job.state = "invalid";
				});
			} finally { if (timer) clearTimeout(timer); controller.abort(); }
		}
		throw new ExhaustedJob(`${kind} failed validation: ${errors}`);
	}
	async derived(sessionId: string, request: DerivedUpdate): Promise<string> {
		return derive(this.store, sessionId, this.tokenizer, this.config, this.model.identity, request, (kind, input, validate, readable) => this.job(sessionId, kind, input, validate, readable));
	}
	async snapshot(sessionId: string, snapshot: Snapshot): Promise<void> {
		for (let repair = 0; ; repair++) {
			try { return await this.processSnapshot(sessionId, snapshot); }
			catch (error) {
				if (error instanceof ExhaustedJob || !(error instanceof MemoryError) || error.code !== "WRITER_INVALID" || repair >= this.config.repairs) throw error;
				let retryable = false;
				update(this.store, sessionId, state => {
					for (const job of state.jobs.filter(j => j.kind === "writer" && j.state === "complete" && j.attempts.length <= this.config.repairs)) {
						const recorded = readJson(this.store, sessionId, job.inputRef) as any;
						if (recorded.input?.snapshotId !== snapshot.id) continue;
						job.state = "invalid"; job.attempts.at(-1)!.error = `Publication validation: ${error.message}`; retryable = true;
					}
				});
				if (!retryable) throw error;
			}
		}
	}
	private async processSnapshot(sessionId: string, snapshot: Snapshot): Promise<void> {
		const state = this.store.load(sessionId).state;
		if (validatedWatermark(state) >= snapshot.end) return;
		if (validatedWatermark(state) !== snapshot.start - 1) fail("MEMORY_PENDING", "Earlier snapshots are not validated");
		const prior = state.ledgers.filter(l => l.cutoff === snapshot.start - 1).at(-1) ?? { version: "ledger-0", cutoff: 0, items: [], claims: [], operations: [], receipts: [], transitions: [] } satisfies Ledger;
		const itemRefs = effectiveItems(prior).map(item => ({ id: item.id, version: item.version, statement: item.statement, kind: item.kind, scope: item.scope, status: item.status, equivalentTo: prior.aliases?.find(a => a.aliasId === item.id)?.canonicalId, ref: saveJson(this.store, sessionId, item) }));
		const directoryRef = this.store.put(sessionId, Buffer.from(itemRefs.map(canonical).join("\n")), "txt");
		const readable = new Set([directoryRef, ...itemRefs.map(i => i.ref)]);
		const pages: ExtractionPage[] = [];
		const owned = originalEvents(state).slice(snapshot.start - 1, snapshot.end);
		const sources = owned.flatMap(event => textSegments(this.store.read(sessionId, event.payloadRef), Math.floor(this.config.writerInputMax / 4), this.tokenizer).map(segment => ({ event, segment,
			defaultEvidence: { sessionId, eventId: event.id, artifactId: event.artifactIds[0], span: { start: segment.start, end: segment.end, encoding: "utf8" }, observationScope: "Shown original source segment" },
			newItemCreatedAt: event.originalSequence, lastTransition: event.originalSequence,
			itemIdPrefix: `${event.id}:item:${segment.start}:`, claimIdPrefix: `${event.id}:claim:${segment.start}:` })));
		for (let from = 0; from < sources.length;) {
			const batch = [sources[from++]];
			while (from < sources.length && batch.length < this.config.writerBatchEvents && !batch.some(s => s.event.id === sources[from].event.id) && this.tokenizer.count(canonical([...batch, sources[from]])) <= this.config.writerInputMax / 3) batch.push(sources[from++]);
			const first = batch[0], last = batch.at(-1)!;
			const precedingExtractionRef = saveJson(this.store, sessionId, pages);
			const declaredEvents = state.events.filter(e => e.origin === "original" && e.sequence <= last.event.sequence);
			const sourceDirectoryRef = this.store.put(sessionId, Buffer.from(declaredEvents.map(e => canonical({ eventId: e.id, sourceRole: e.producer, authority: e.authority, sequence: e.originalSequence, ref: e.payloadRef })).join("\n")), "txt");
			for (const ref of [precedingExtractionRef, sourceDirectoryRef, ...declaredEvents.map(e => e.payloadRef)]) readable.add(ref);
			let cursor: string | null = null;
			const cursors = new Set<string>(), segmentPages: ExtractionPage[] = [];
			for (let pageIndex = 0; ; pageIndex++) {
				if (pageIndex >= this.config.writerPageMax) fail("WRITER_INVALID", "Extraction did not finish within page limit");
				const input = json({ sessionId, snapshotId: snapshot.id, ledgerVersion: prior.version, ledgerDirectoryRef: directoryRef, precedingExtractionRef, sourceDirectoryRef,
					source: first, ...(batch.length > 1 ? { sources: batch } : {}), itemIdPrefix: first.itemIdPrefix, claimIdPrefix: first.claimIdPrefix, cursor,
					previousPageRefs: segmentPages.map(p => { const ref = saveJson(this.store, sessionId, p); readable.add(ref); return ref; }) });
				const page = await this.job(sessionId, "writer", input, output => {
					const validated = validatePage(output, state, this.store, new Set(batch.map(s => s.event.id)), new Set(declaredEvents.map(e => e.id)), new Map(batch.map(s => [s.event.id, s.segment])));
					for (const { event } of batch) if (validated.complete && event.kind === "user_message" && ![...segmentPages, validated].some(p => p.receipts.some(r => r.eventId === event.id))) fail("WRITER_INVALID", `Missing user-message review receipt for ${event.id}`);
					return validated;
				}, readable);
				segmentPages.push(page);
				if (page.complete) break;
				if (cursors.has(page.nextCursor!)) fail("WRITER_INVALID", "Repeated extraction cursor");
				cursors.add(page.nextCursor!); cursor = page.nextCursor;
			}
			pages.push(...segmentPages);
		}
		const mutations = mergeById(pages.flatMap(p => p.mutations), m => `${m.item.id}:${m.item.version}`).sort((a, b) => state.events.find(e => e.id === a.atEventId)!.sequence - state.events.find(e => e.id === b.atEventId)!.sequence || a.item.version - b.item.version || a.item.id.localeCompare(b.item.id));
		const claims = mergeById(pages.flatMap(p => p.claims), c => c.id);
		const ledger: Ledger = structuredClone(prior);
		ledger.cutoff = snapshot.end;
		const declaredInputs = new Set(state.events.filter(e => e.origin === "original" && e.originalSequence! <= snapshot.end).map(e => e.id));
		for (const mutation of mutations) {
			const previous = ledger.items.find(i => i.id === mutation.item.id);
			if (ledger.aliases?.some(a => a.aliasId === mutation.item.id)) fail("WRITER_INVALID", "Mutate an alias's canonical ID instead");
			validateMutation(mutation, previous, state);
			let review: Review | undefined;
			if (requiresReview(mutation, previous)) {
				const reviewSources = [...new Map([...mutation.evidence, ...mutation.item.completionEvidence, ...mutation.item.sourceRefs, ...mutation.item.exactUserExcerptRefs, ...(previous?.sourceRefs ?? []), ...(previous?.exactUserExcerptRefs ?? [])].map(ref => [canonical(ref), ref])).values()];
				const excerpts = reviewSources.map(ref => {
					const event = evidence(ref, state, this.store, declaredInputs);
					const artifact = state.artifacts.find(a => a.id === (ref.artifactId ?? event.artifactIds[0]))!;
					const bytes = this.store.read(sessionId, artifact.storageRef);
					return { ref, event: { id: event.id, authority: event.authority, kind: event.kind, originalSequence: event.originalSequence, workspaceVersion: event.workspaceVersion, observationScope: event.observationScope, originalEvidenceIds: event.originalEvidenceIds }, text: Buffer.from(ref.span ? bytes.slice(ref.span.start, ref.span.end) : bytes).toString("utf8") };
				});
				review = await this.job(sessionId, "reviewer", json({ previous: previous ?? null, mutation, originalExcerpts: excerpts }), value => {
					value = structuredClone(value);
					object(value); oneOf(value.verdict, ["supported", "unsupported", "ambiguous"]); string(value.explanation); array(value.evidence);
					const result = value as unknown as Review;
					if (!result.evidence.length) fail("WRITER_INVALID", "Evidence reviewer omitted source spans");
					for (const ref of result.evidence) { evidence(ref, state, this.store, new Set(reviewSources.map(r => r.eventId))); if (!ref.span) fail("WRITER_INVALID", "Review needs original source spans"); }
					return result;
				});
			}
			const accepted = !review || review.verdict === "supported";
			ledger.transitions.push({ mutation, accepted, ...(review ? { review } : {}) });
			if (accepted) {
				if (previous) ledger.items[ledger.items.indexOf(previous)] = mutation.item;
				else ledger.items.push(mutation.item);
			} else if (!previous) {
				// Rejecting an unsupported initial completion must not erase a new request.
				ledger.items.push({ ...mutation.item, status: "active", completionEvidence: [], supersedesIds: [], supersededByIds: [] });
			} else if (review?.verdict === "ambiguous" && previous) {
				// Keep the full prior item. Conflict is a separate current-state annotation.
				ledger.transitions.at(-1)!.reason = `Unresolved scope conflict for ${previous.id}`;
			}
		}
		for (const item of ledger.items) for (const related of [...item.dependencies, ...item.supersedesIds, ...item.supersededByIds, ...(item.parentId ? [item.parentId] : [])]) if (!ledger.items.some(i => i.id === related)) fail("WRITER_INVALID", "Unresolved work-item relationship");
		for (const claim of claims) {
			if (claim.category === "completed" && (!claim.itemIds.length || claim.itemIds.some(id => ledger.items.find(i => i.id === id)?.status !== "completed"))) fail("WRITER_INVALID", "Completion claim was not supported by accepted item-specific evidence review");
			for (const related of claim.itemIds) if (!ledger.items.some(i => i.id === related)) fail("WRITER_INVALID", "Claim references an uncommitted item");
			// Invalidation is only factual, never a route to changing instruction authority.
			for (const invalidated of claim.invalidatesIds) {
				const old = ledger.claims.find(c => c.id === invalidated);
				if (!old || old.category === "explicit_user" || claim.category !== "observation") fail("WRITER_INVALID", "Unsupported historical invalidation");
			}
		}
		ledger.claims = mergeById([...ledger.claims, ...claims], c => c.id);
		for (const event of owned.filter(e => e.kind === "user_message")) {
			const receipts = pages.flatMap(p => p.receipts).filter(r => r.eventId === event.id);
			if (!receipts.length) fail("WRITER_INVALID", "Missing user-message receipt after merge");
			const itemIds = [...new Set(receipts.flatMap(r => r.itemIds))].sort();
			for (const itemId of itemIds) if (!ledger.items.some(i => i.id === itemId) && !ledger.transitions.some(t => t.mutation.item.id === itemId)) fail("WRITER_INVALID", "Receipt refers to nonexistent extraction item");
			ledger.receipts.push({ eventId: event.id, itemIds, classification: receipts.find(r => r.classification !== "no_change")?.classification ?? "no_change", reason: receipts.map(r => r.reason).join("; ") });
		}
		replayOperations(ledger, owned);
		ledger.version = id("l", sessionId, snapshot.id, prior.version, ledger);
		// Select original claims in bounded groups, never prose summaries of summaries.
		const selected: string[] = [];
		let title = `Events ${snapshot.start}-${snapshot.end}`;
		let group: typeof claims = [];
		const choose = async () => {
			if (!group.length) return;
			const current = group; group = [];
			const choice = await this.job(sessionId, "block", json({ snapshotId: snapshot.id, claims: current, tokenLimit: this.config.blockPreferred }), value => {
				object(value); string(value.title); strings(value.claimIds); unique(value.claimIds);
				if (value.claimIds.some(i => !current.some(c => c.id === i))) fail("WRITER_INVALID", "Block invented a claim ID");
				return { title: value.title, claimIds: value.claimIds };
			});
			title = choice.title; selected.push(...choice.claimIds);
		};
		for (const claim of claims) {
			if (this.tokenizer.count(canonical([...group, claim])) > this.config.writerInputMax / 2) await choose();
			group.push(claim);
		}
		await choose();
		const included: typeof claims = [];
		const content = () => json({ kind: "historical_snapshot", snapshotId: snapshot.id, cutoff: snapshot.end, title, claims: included });
		if (this.tokenizer.count(escapeData(content())) > this.config.blockMax) fail("WRITER_INVALID", "Block title exceeds block cap");
		for (const claimId of [...new Set(selected)]) {
			const claim = claims.find(c => c.id === claimId)!; included.push(claim);
			if (this.tokenizer.count(escapeData(content())) > this.config.blockMax) included.pop();
		}
		const rendered = escapeData(content());
		const generationJobIds = this.store.load(sessionId).state.jobs.filter(job => {
			if (job.state !== "complete" || !["writer", "block"].includes(job.kind)) return false;
			return (readJson(this.store, sessionId, job.inputRef) as any).input?.snapshotId === snapshot.id;
		}).map(job => job.id);
		if (!generationJobIds.length) fail("WRITER_INVALID", "Publication has no completed generation job");
		const validationRef = saveJson(this.store, sessionId, { schemaVersion: 1, generationJobIds, contextLedgerVersion: prior.version, snapshotId: snapshot.id, sourceDigest: snapshot.sourceDigest, receipts: ledger.receipts.filter(r => owned.some(e => e.id === r.eventId)), checked: ["source_refs", "spans", "receipts", "ledger_versions", "transitions", "operations", "block_tokens"], semanticFidelity: "not established by structural checks" });
		const block: Block = { id: id("b", snapshot.id, rendered, this.model.identity, PROMPT_VERSIONS.writer), snapshotId: snapshot.id, sourceDigest: snapshot.sourceDigest, ledgerVersion: ledger.version, title, claimIds: included.map(c => c.id), content: content(), rendered, tokens: this.tokenizer.count(rendered), tokenizerId: this.tokenizer.id, jobId: generationJobIds.at(-1)!, writerPromptVersion: PROMPT_VERSIONS.writer, modelIdentity: this.model.identity, validationRef, archiveRef: saveJson(this.store, sessionId, content()) };
		update(this.store, sessionId, current => {
			const watermark = validatedWatermark(current);
			if (watermark >= snapshot.end) return; // Duplicate result delivery cannot reapply transitions.
			if (watermark !== snapshot.start - 1 || (current.ledgers.at(-1)?.version ?? "ledger-0") !== prior.version) fail("REVISION_CONFLICT", "Ledger coverage or reconciliation version changed before publication");
			current.blocks.push(block); current.ledgers.push(ledger); current.extractions.push({ snapshotId: snapshot.id, pages });
		});
	}
	async trajectory(sessionId: string, ledger: Ledger, blocks: Block[]): Promise<TrajectoryPlan> {
		// Page the model's classification input. Runtime renders complete operational records.
		const entries: TrajectoryPlan["entries"] = [];
		const active = canonicalItems(ledger).filter(i => OPEN.has(i.status));
		const state = this.store.load(sessionId).state;
		const findings = ledger.claims.map(claim => ({ claim, currentStatus: annotations(claim, ledger, state), ref: saveJson(this.store, sessionId, claim) }));
		const findingDirectoryRef = this.store.put(sessionId, Buffer.from(findings.map(f => canonical({ id: f.claim.id, category: f.claim.category, itemIds: f.claim.itemIds, entities: f.claim.entities, currentStatus: f.currentStatus, ref: f.ref })).join("\n")), "txt");
		const blockDirectoryRef = this.store.put(sessionId, Buffer.from(blocks.map(b => canonical({ id: b.id, title: b.title, claimIds: b.claimIds, ref: b.archiveRef })).join("\n")), "txt");
		const sources = state.events.filter(e => e.origin === "original" && e.originalSequence! <= ledger.cutoff);
		const sourceDirectoryRef = this.store.put(sessionId, Buffer.from(sources.map(e => canonical({ eventId: e.id, sourceRole: e.producer, authority: e.authority, ref: e.payloadRef })).join("\n")), "txt");
		const readable = new Set([findingDirectoryRef, blockDirectoryRef, sourceDirectoryRef, ...findings.map(f => f.ref), ...blocks.map(b => b.archiveRef), ...sources.map(e => e.payloadRef)]);
		const relevantFindings: typeof findings = [];
		for (const finding of findings.slice().reverse()) {
			if (!finding.claim.itemIds.some(id => active.some(item => item.id === id)) && !["changed", "tested", "completed", "observation"].includes(finding.claim.category)) continue;
			if (this.tokenizer.count(canonical([...relevantFindings, finding])) <= this.config.writerInputMax / 6) relevantFindings.push(finding);
		}
		let nextAction: TrajectoryPlan["nextAction"] = { text: "Inspect current state and retrieve required evidence before choosing an implementation action.", origin: "agent_proposal", itemIds: [], evidenceBlockIds: [], retrievalPrerequisites: [] };
		const conflicts = [...new Set(ledger.items.flatMap(i => i.conflicts))];
		const requiredBlockIds = new Set<string>();
		let group: typeof active = [];
		const generate = async () => {
			const items = group; group = [];
			const plan = await this.job(sessionId, "trajectory", json({ cutoff: ledger.cutoff, ledgerVersion: ledger.version, items, relevantFindings, findingDirectoryRef, blockDirectoryRef, sourceDirectoryRef, conflictIds: conflicts, blocks: blocks.slice(-3).map(b => ({ id: b.id, title: b.title })) }), value => {
				object(value); array(value.entries); object(value.nextAction); strings(value.conflictIds); strings(value.requiredBlockIds);
				if (value.schemaVersion !== 1 || value.cutoff !== ledger.cutoff) fail("WRITER_INVALID", "Trajectory cutoff mismatch");
				const plan = value as unknown as TrajectoryPlan;
				for (const entry of plan.entries) { object(entry); string(entry.itemId); oneOf(entry.category, [...CATEGORIES]); }
				unique(plan.entries.map(e => e.itemId));
				if (canonical(plan.entries.map(e => e.itemId).sort()) !== canonical(items.map(i => i.id).sort())) fail("WRITER_INVALID", "Trajectory omits or invents active item IDs");
				string(plan.nextAction.text); oneOf(plan.nextAction.origin, ["agent_proposal"]);
				strings(plan.nextAction.itemIds); strings(plan.nextAction.evidenceBlockIds); strings(plan.nextAction.retrievalPrerequisites);
				if (plan.nextAction.itemIds.some(id => !items.some(i => i.id === id))) fail("WRITER_INVALID", "Next action references an absent item");
				if (canonical([...plan.conflictIds].sort()) !== canonical([...conflicts].sort())) fail("WRITER_INVALID", "Trajectory omits conflicts");
				if ([...plan.requiredBlockIds, ...plan.nextAction.evidenceBlockIds].some(id => !blocks.some(b => b.id === id))) fail("WRITER_INVALID", "Trajectory references nonexistent evidence block");
				return plan;
			}, readable);
			entries.push(...plan.entries);
			if (!nextAction.itemIds.length && plan.nextAction.itemIds.length) nextAction = plan.nextAction;
			for (const id of [...plan.requiredBlockIds, ...plan.nextAction.evidenceBlockIds]) requiredBlockIds.add(id);
		};
		for (const item of active) {
			if (this.tokenizer.count(canonical([...group, item])) > this.config.writerInputMax / 2 && group.length) await generate();
			group.push(item);
		}
		await generate();
		return { schemaVersion: 1, cutoff: ledger.cutoff, entries, nextAction, conflictIds: conflicts, requiredBlockIds: [...requiredBlockIds] };
	}
}
