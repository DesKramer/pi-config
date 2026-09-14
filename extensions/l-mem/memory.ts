import { stripVTControlCharacters } from "node:util";
import type { Artifact, Config, ContextRequest, EventInput, Handoff, HostBinding, Json, LookupQuery, LookupResult, ModelBinding, Result, SessionState, SourceEvent, Store, Tokenizer, TrajectoryPlan } from "./contracts.ts";
import { DEFAULT_CONFIG } from "./contracts.ts";
import { attempt, canonical, digest, fail, failure, hash, id, json, saveJson, update } from "./storage.ts";
import { Generation } from "./generation.ts";
import { originalEvents, sealSnapshots, sourceWatermark, textSegments, validatedWatermark } from "./snapshots.ts";
import { annotations, OPEN } from "./validation.ts";
import { canonicalItems, currentBlocks, effectiveItems } from "./derived.ts";
import { publishedReferences } from "./storage.ts";
import type { DerivedUpdate } from "./contracts.ts";
type AdvanceResult = { validatedThrough: number; sealedThrough: number; derivedId?: string };
import { assemble, availableBudget, refreshHandoff, runtimeControls, tailFor } from "./context.ts";

export class SessionMemory {
	readonly config: Config;
	private generation?: Generation;
	private streams = new Map<string, Promise<Result<AdvanceResult>>>();
	readonly store: Store;
	readonly tokenizer: Tokenizer;
	readonly host: HostBinding;
	readonly now: () => number;
	constructor(store: Store, tokenizer: Tokenizer, host: HostBinding, model?: ModelBinding, configuration: Partial<Config> = {}, now: () => number = Date.now) {
		this.store = store; this.tokenizer = tokenizer; this.host = host; this.now = now;
		this.config = structuredClone({ ...DEFAULT_CONFIG, ...configuration });
		const c = this.config;
		for (const key of ["snapshotMin", "snapshotTarget", "snapshotMax", "blockPreferred", "blockMax", "historyMax", "trajectoryMax", "continuityMax", "tailPreferred", "tailPlanningMax", "writerInputMax", "writerOutputMax", "writerPageMax", "writerBatchEvents", "jobTimeoutMs"] as const) if (!Number.isSafeInteger(c[key]) || c[key] <= 0) fail("INVALID_EVENT", `Invalid configuration ${key}`);
		if (c.snapshotMin > c.snapshotTarget || c.snapshotTarget > c.snapshotMax || c.blockMax > 4000 || c.historyMax > 30000 || c.trajectoryMax > 5000 || c.continuityMax > 35000 || !Number.isSafeInteger(c.repairs) || c.repairs < 0) fail("INVALID_EVENT", "Configuration violates memory allocation limits");
		if (!tokenizer.id || !host.version || !host.archiveCapability) fail("UNSUPPORTED_HOST_CAPABILITY", "Tokenizer, renderer and readable archive capability are required");
		// Count failures are explicit. A tokenizer must never return NaN or fractional estimates.
		const count = tokenizer.count.bind(tokenizer);
		this.tokenizer = { ...tokenizer, count(text) { const n = count(text); if (!Number.isSafeInteger(n) || n < 0) fail("UNSUPPORTED_HOST_CAPABILITY", "Invalid token accounting result"); return n; } };
		if (model) this.generation = new Generation(store, this.tokenizer, model, this.config, now);
	}
	private resultFailure<T>(sessionId: string, error: unknown): Result<T> {
		const result = failure(error);
		try { update(this.store, sessionId, state => { state.failures.push(result); }); } catch { /* Preserve the original failure when storage itself is unavailable. */ }
		return result;
	}
	recordEvent(sessionId: string, producerEventId: string, input: EventInput): Result<SourceEvent> {
		return attempt(() => {
			if (!sessionId || !producerEventId || typeof input.payload !== "string" || !Number.isFinite(input.timestamp) || !input.producer || !Array.isArray(input.causalParentIds)) fail("INVALID_EVENT", "Stable identity, timestamp, producer, text and causal references are required");
			if (Buffer.from(input.payload, "utf8").toString("utf8") !== input.payload) fail("INVALID_EVENT", "Visible payload contains unpaired UTF-16 surrogates and cannot be archived exactly as UTF-8");
			if (!["original", "derived_memory", "runtime_control"].includes(input.origin) || !["user", "agent", "tool", "host"].includes(input.authority) || !["delivered", "pending", "unknown"].includes(input.deliveryState)) fail("INVALID_EVENT", "Invalid origin, authority or delivery state");
			if (!["user_message", "agent_message", "tool_request", "tool_result", "operation_status", "workspace_change"].includes(input.kind)) fail("INVALID_EVENT", "Invalid event kind");
			if (input.kind === "user_message" && input.authority !== "user") fail("INVALID_EVENT", "User messages must preserve user authority");
			if (["tool_request", "tool_result"].includes(input.kind) && (!input.toolCallId || !input.operationId)) fail("INVALID_EVENT", "Tool lifecycle events require tool and operation IDs");
			if (input.operationStatus && !["running", "completed", "failed", "unknown"].includes(input.operationStatus)) fail("INVALID_EVENT", "Invalid operation state");
			const normalized = json(input) as unknown as EventInput, inputDigest = digest(normalized);
			return update(this.store, sessionId, state => {
				const duplicate = state.events.find(e => e.producerEventId === producerEventId);
				if (duplicate) {
					if (duplicate.inputDigest !== inputDigest) fail("DUPLICATE_EVENT_CONFLICT", "Producer event ID was reused with different content");
					return duplicate;
				}
				for (const parent of [...input.causalParentIds, ...(input.respondsToEventIds ?? []), ...(input.originalEvidenceIds ?? [])]) if (!state.events.some(e => e.id === parent)) fail("INVALID_EVENT", "Causal or evidence reference is not an earlier event in this session");
				if (input.origin === "original" && input.kind === "tool_request" && state.events.some(e => e.origin === "original" && e.kind === "tool_request" && (e.operationId === input.operationId || e.toolCallId === input.toolCallId))) fail("DUPLICATE_EVENT_CONFLICT", "A tool or operation ID cannot identify a second dispatch intent");
				if (input.origin === "original" && input.kind === "tool_result" && !state.events.some(e => e.origin === "original" && e.kind === "tool_request" && e.operationId === input.operationId && e.toolCallId === input.toolCallId)) fail("INVALID_EVENT", "Tool result has no associated original dispatch intent");
				const eventId = id("e", sessionId, producerEventId);
				const artifacts: Artifact[] = [];
				const inputs = [{ content: input.payload, encoding: "utf8" as const, mediaType: "text/plain", captureKind: "agent_visible" as const, completeness: input.truncationMetadata ? "truncated" as const : "complete" as const }, ...(input.artifacts ?? [])];
				for (const [ordinal, artifact] of inputs.entries()) {
					if (!["utf8", "base64"].includes(artifact.encoding) || !["agent_visible", "auxiliary_capture", "workspace_snapshot"].includes(artifact.captureKind) || !["complete", "truncated", "unavailable"].includes(artifact.completeness) || typeof artifact.content !== "string" || !artifact.mediaType) fail("INVALID_EVENT", "Invalid artifact metadata");
					const bytes = Buffer.from(artifact.content, artifact.encoding === "utf8" ? "utf8" : "base64");
					if (artifact.encoding === "base64" && bytes.toString("base64") !== artifact.content) fail("INVALID_EVENT", "Noncanonical binary artifact encoding");
					const { content: _, encoding: __, ...metadata } = artifact;
					artifacts.push({ ...metadata, sessionId, id: id("a", sessionId, eventId, ordinal, hash(bytes)), hash: hash(bytes), byteLength: bytes.length, storageRef: this.store.put(sessionId, bytes, artifact.encoding === "utf8" ? "txt" : "bin"), eventIds: [eventId] });
				}
				const { payload: _, message, artifacts: __, ...metadata } = normalized;
				const event: SourceEvent = { ...metadata, sessionId, id: eventId, producerEventId, sequence: state.events.length + 1, ...(input.origin === "original" ? { originalSequence: sourceWatermark(state) + 1 } : {}), inputDigest, payloadRef: artifacts[0].storageRef, ...(message !== undefined ? { messageRef: saveJson(this.store, sessionId, message) } : {}), artifactIds: artifacts.map(a => a.id), visibleTokens: this.tokenizer.count(input.payload), tokenizerId: this.tokenizer.id };
				state.artifacts.push(...artifacts); state.events.push(event); return event;
			});
		});
	}
	advanceMemory(sessionId: string, throughSequence?: number | DerivedUpdate): Promise<Result<AdvanceResult>> {
		const previous = this.streams.get(sessionId);
		const work = async (): Promise<Result<AdvanceResult>> => {
			try {
				if (throughSequence && typeof throughSequence === "object") {
					if (!this.generation) fail("UNSUPPORTED_HOST_CAPABILITY", "Derived updates require the restricted memory model");
					const derivedId = await this.generation.derived(sessionId, throughSequence);
					const state = this.store.load(sessionId).state;
					return { ok: true, value: { validatedThrough: validatedWatermark(state), sealedThrough: state.snapshots.at(-1)?.end ?? 0, derivedId } };
				}
				update(this.store, sessionId, state => sealSnapshots(state, this.store, this.config, this.tokenizer, this.now(), throughSequence));
				if (!this.generation) fail("UNSUPPORTED_HOST_CAPABILITY", "Memory model invocation is not bound; snapshots remain uncovered");
				const state = this.store.load(sessionId).state;
				for (const snapshot of state.snapshots.filter(s => throughSequence === undefined || s.end <= throughSequence)) await this.generation.snapshot(sessionId, snapshot);
				const current = this.store.load(sessionId).state;
				return { ok: true, value: { validatedThrough: validatedWatermark(current), sealedThrough: current.snapshots.at(-1)?.end ?? 0 } };
			} catch (error) { return this.resultFailure(sessionId, error); }
		};
		const promise = previous ? previous.then(work, work) : work();
		this.streams.set(sessionId, promise);
		void promise.finally(() => { if (this.streams.get(sessionId) === promise) this.streams.delete(sessionId); });
		return promise;
	}
	async prepareCompaction(sessionId: string, request: ContextRequest): Promise<Result<Handoff>> {
		try {
			if (!request || typeof request.requestId !== "string" || !request.requestId || typeof request.contextRevision !== "string" || !Array.isArray(request.unactedUserEventIds) || request.unactedUserEventIds.some(id => typeof id !== "string")) fail("INVALID_EVENT", "Preparation requires a request ID, context revision and unacted-user directory");
			if (request.exactTailEventIds !== undefined && (!Array.isArray(request.exactTailEventIds) || request.exactTailEventIds.some(id => typeof id !== "string"))) fail("INVALID_EVENT", "Current protocol inputs must be an event-ID array");
			if (request.preferLatestCutoff !== undefined && typeof request.preferLatestCutoff !== "boolean") fail("INVALID_EVENT", "Latest-cutoff preference must be boolean");
			availableBudget(request, this.config, this.tokenizer);
			if (!this.generation) fail("UNSUPPORTED_HOST_CAPABILITY", "Memory model invocation is not bound");
			const captured = this.store.load(sessionId).state, watermark = sourceWatermark(captured);
			if (request.cutoff !== undefined && (!Number.isSafeInteger(request.cutoff) || request.cutoff < 0 || request.cutoff > watermark)) fail("INVALID_EVENT", "Cutoff is outside captured original history");
			const replay = captured.handoffs.find(h => !captured.legacyHandoffIds?.includes(h.id) && (h.derivedRevision ?? 0) === (captured.derivedRevision ?? 0) && h.watermark === watermark && canonical(h.controlEventIds ?? []) === canonical(runtimeControls(captured).map(e => e.id)) && canonical(h.request) === canonical(request) && canonical(h.configuration) === canonical(this.config) && h.tokenizerId === this.tokenizer.id && h.hostVersion === this.host.version);
			if (replay) {
				// Reuse cannot turn missing historical evidence into an apparently valid handoff.
				this.store.read(sessionId, replay.payloadRef);
				for (const ref of replay.indexRefs ?? []) this.store.read(sessionId, ref);
				for (const e of [...captured.events.filter(e => e.originalSequence! <= watermark), ...runtimeControls(captured)]) {
					this.store.read(sessionId, e.payloadRef); if (e.messageRef) this.store.read(sessionId, e.messageRef);
				}
				return { ok: true, value: replay };
			}
			const events = originalEvents(captured);
			let desired = watermark, maximum = watermark, tokens = 0;
			while (desired > 0 && tokens < this.config.tailPreferred) { desired--; tokens += this.tokenizer.count(Buffer.from(this.store.read(sessionId, events[desired].payloadRef)).toString("utf8")); }
			for (const eventId of request.unactedUserEventIds) {
				const event = events.find(e => e.id === eventId && e.kind === "user_message");
				if (!event) fail("INVALID_EVENT", "Unknown unacted user message");
				maximum = Math.min(maximum, event.originalSequence! - 1); desired = Math.min(desired, maximum);
			}
			for (const eventId of request.exactTailEventIds ?? []) {
				const event = events.find(e => e.id === eventId);
				if (!event) fail("INVALID_EVENT", "Unknown current protocol input");
				maximum = Math.min(maximum, event.originalSequence! - 1); desired = Math.min(desired, maximum);
			}
			if (request.preferLatestCutoff) desired = maximum;
			if (request.cutoff !== undefined) desired = request.cutoff;
			const sealedEnd = captured.snapshots.at(-1)?.end ?? 0;
			let candidates = captured.snapshots.filter(s => s.end <= watermark).map(s => s.end);
			if (desired >= sealedEnd && desired <= watermark) candidates.push(desired);
			// A large older tool result may not fit the preferred exact tail. Try
			// later coherent endpoints, rather than repeatedly retaining that result.
			candidates.push(...events.filter(e => e.coherentCut && e.originalSequence! >= sealedEnd).map(e => e.originalSequence!), watermark, 0);
			candidates = [...new Set(candidates)].filter(c => c >= (captured.minimumHandoffCutoff ?? 0) && (request.cutoff === undefined ? c <= maximum : c === request.cutoff)).sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired) || b - a);
			if (request.cutoff === undefined && !request.preferLatestCutoff) {
				// Do not force a short snapshot at each tool boundary merely to
				// maintain tailPreferred. Prefer published coverage (or the prior
				// cutoff) while the complete exact tail still fits. New snapshots
				// can generate in the background without blocking this safe view.
				const prior = captured.handoffs.findLast(h => !captured.legacyHandoffIds?.includes(h.id) && (h.derivedRevision ?? 0) === (captured.derivedRevision ?? 0) && h.tokenizerId === this.tokenizer.id && h.hostVersion === this.host.version && canonical(h.configuration) === canonical(this.config));
				const ready = captured.ledgers.at(-1)?.cutoff ?? prior?.cutoff;
				if (ready !== undefined && candidates.includes(ready)) candidates = [ready, ...candidates.filter(c => c !== ready)];
			}
			let lastError: unknown;
			for (const cutoff of candidates) {
				try {
					// An earlier candidate or background writer may have sealed a
					// larger range since selection. Its interior is no longer eligible.
					if (request.cutoff === undefined && this.store.load(sessionId).state.snapshots.some(s => s.start <= cutoff && cutoff < s.end)) continue;
					tailFor(captured, cutoff, watermark, request, this.host);
					if (cutoff > 0 && !captured.ledgers.some(l => l.cutoff === cutoff)) {
						const advance = await this.advanceMemory(sessionId, cutoff);
						if (!advance.ok) fail(advance.code, advance.message);
					}
					const state = this.store.load(sessionId).state;
					const ledger = cutoff === 0 ? { version: "ledger-0", cutoff: 0, items: [], claims: [], receipts: [], transitions: [], operations: [] } : state.ledgers.filter(l => l.cutoff === cutoff).at(-1);
					if (!ledger) fail("MEMORY_PENDING", "No immutable ledger version at selected cutoff");
					const blocks = currentBlocks(state).filter(b => state.snapshots.find(s => s.id === b.snapshotId)!.end <= cutoff);
					const plan = await this.generation.trajectory(sessionId, ledger, blocks);
					const handoff = assemble(state, this.store, this.tokenizer, this.host, this.config, request, cutoff, watermark, ledger, plan);
					update(this.store, sessionId, current => { if (!current.handoffs.some(h => h.id === handoff.id)) current.handoffs.push(handoff); });
					return { ok: true, value: handoff };
				} catch (error) {
					// A final uncompressed-capacity refusal must not conceal the
					// writer/evidence failure that prevented a usable compacted view.
					const rank = (error: unknown) => {
						const code = failure(error).code;
						return ["CONTEXT_BUDGET_EXCEEDED", "ACTIVE_STATE_TOO_LARGE"].includes(code) ? 0 : ["REVISION_CONFLICT", "MEMORY_PENDING", "ILLEGAL_TOOL_SEQUENCE", "UNSUPPORTED_HOST_CAPABILITY"].includes(code) ? 1 : 2;
					};
					if (!lastError || rank(error) > rank(lastError)) lastError = error;
				}
			}
			if (!lastError) fail("MEMORY_PENDING", "No eligible endpoint satisfies exact-tail and corrected-ledger version requirements");
			throw lastError;
		} catch (error) { return this.resultFailure(sessionId, error); }
	}
	activateHandoff(sessionId: string, handoffId: string, expectedContextRevision: string): Result<{ handoffId: string; dispatchId: string; state: "accepted" | "sent" | "unknown"; watermark: number }> {
		try {
			const state = this.store.load(sessionId).state;
			const handoff = state.handoffs.find(h => h.id === handoffId);
			if (!handoff) fail("NOT_FOUND", "Prepared handoff does not exist");
			if (state.legacyHandoffIds?.includes(handoff.id) || (handoff.derivedRevision ?? 0) !== (state.derivedRevision ?? 0) || handoff.cutoff < (state.minimumHandoffCutoff ?? 0)) fail("REVISION_CONFLICT", "Memory was migrated or corrected; prepare a new handoff");
			if (handoff.request.contextRevision !== expectedContextRevision) fail("REVISION_CONFLICT", "Unexpected host context revision");
			const existing = state.activations.find(a => a.preparationHandoffId === handoffId || a.handoffId === handoffId);
			if (existing) return { ok: true, value: existing };
			if (!this.host.dispatch) fail("UNSUPPORTED_HOST_CAPABILITY", "Atomic dispatch barrier, context-revision CAS and recoverable accepted/sent state are not bound");
			if (handoff.tokenizerId !== this.tokenizer.id || handoff.hostVersion !== this.host.version || canonical(handoff.configuration) !== canonical(this.config)) fail("REVISION_CONFLICT", "Host, tokenizer or configuration changed; prepare again");
			const activated = this.host.dispatch.activate(sessionId, handoffId, expectedContextRevision, () => attempt(() => {
				const current = this.store.load(sessionId).state;
				if ((handoff.derivedRevision ?? 0) !== (current.derivedRevision ?? 0)) fail("REVISION_CONFLICT", "Derived memory changed before dispatch");
				const refreshed = refreshHandoff(current, this.store, this.tokenizer, this.host, handoff);
				update(this.store, sessionId, s => { if (!s.handoffs.some(h => h.id === refreshed.id)) s.handoffs.push(refreshed); });
				return refreshed;
			}));
			if (!activated.ok) return activated;
			const record = { handoffId: activated.value.handoff.id, preparationHandoffId: handoffId, dispatchId: activated.value.dispatchId, state: activated.value.state, watermark: activated.value.handoff.watermark };
			update(this.store, sessionId, current => { if (!current.activations.some(a => a.preparationHandoffId === handoffId)) current.activations.push(record); });
			return { ok: true, value: record };
		} catch (error) { return this.resultFailure(sessionId, error); }
	}
	lookup(sessionId: string, query: LookupQuery, limits: { tokens: number }): Result<LookupResult> {
		return attempt(() => {
			if (!Number.isSafeInteger(limits.tokens) || limits.tokens < 128) fail("CONTEXT_BUDGET_EXCEEDED", "Lookup requires at least 128 response tokens");
			if (!query || !["reference", "events", "search", "block", "item"].includes(query.kind)) fail("INVALID_REFERENCE", "Unknown lookup query");
			if (query.kind === "reference" && typeof query.ref !== "string") fail("INVALID_REFERENCE", "Reference must be a string");
			if (query.kind === "search" && typeof query.text !== "string") fail("INVALID_REFERENCE", "Search must be literal text");
			if (query.kind === "events" && (!Number.isSafeInteger(query.start) || !Number.isSafeInteger(query.end) || query.start < 1 || query.end < query.start)) fail("INVALID_REFERENCE", "Invalid original-event range");
			const state = this.store.load(sessionId).state, storedLedger = state.ledgers.at(-1), ledger = storedLedger ? { ...storedLedger, items: effectiveItems(storedLedger) } : undefined;
			const results: Json[] = [];
			let continuation: LookupQuery | null = null;
			if (query.kind === "reference") {
				// Only published references, never orphan files or arbitrary filesystem paths.
				const refs = publishedReferences(state);
				if (!refs.has(query.ref)) fail("INVALID_REFERENCE", "Reference is not published in this session");
				const bytes = this.store.read(sessionId, query.ref), offset = query.offset ?? 0;
				if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) fail("INVALID_REFERENCE", "Invalid byte offset");
				const artifact = state.artifacts.find(a => a.storageRef === query.ref);
				const binary = artifact ? !artifact.mediaType.startsWith("text/") && artifact.mediaType !== "application/json" : false;
				let end: number;
				try { end = binary ? Math.min(bytes.length, offset + Math.max(1, Math.floor(limits.tokens / 4))) : offset + textSegments(bytes.slice(offset), Math.max(1, Math.floor(limits.tokens / 2)), this.tokenizer)[0].end; }
				catch { return fail("INVALID_REFERENCE", "Reference is not UTF-8 text or offset splits a character; binary artifacts require binary metadata"); }
				const row = () => json({ ref: query.ref, offset, end, byteLength: bytes.length, text: binary ? Buffer.from(bytes.slice(offset, end)).toString("base64") : new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(offset, end)), encoding: binary ? "base64" : "utf8", historicalObservation: true });
				while (end > offset) {
					try { const trial = row(); if (this.tokenizer.count(canonical({ results: [trial], continuation: end < bytes.length ? { ...query, offset: end } : null })) + 32 <= limits.tokens) { results.push(trial); break; } } catch { /* Move back to a legal UTF-8 boundary. */ }
					end--;
				}
				if (end === offset && offset < bytes.length) fail("CONTEXT_BUDGET_EXCEEDED", "Lookup cannot hold its framing and one source character");
				if (end < bytes.length) continuation = { ...query, offset: end };
			} else {
				let candidates: Json[] = [];
				if (query.kind === "item") candidates = ledger?.items.filter(i => i.id === query.id).map(i => json({ ...i, equivalentTo: ledger.aliases?.find(a => a.aliasId === i.id)?.canonicalId })) ?? [];
				if (query.kind === "block" || query.kind === "search") candidates.push(...state.blocks.filter(b => query.kind === "block" ? b.id === query.id : query.kind === "search" && canonical(b.content).toLowerCase().includes(query.text.toLowerCase())).map(b => json({ id: b.id, title: b.title, snapshot: state.snapshots.find(s => s.id === b.snapshotId), ref: b.archiveRef, tokens: b.tokens, currentStatus: ledger?.claims.filter(c => b.claimIds.includes(c.id)).map(c => ({ id: c.id, annotations: annotations(c, ledger, state) })) ?? [] })));
				if (query.kind === "events" || query.kind === "search") candidates.push(...originalEvents(state).filter(e => query.kind === "events" ? e.originalSequence! >= query.start && e.originalSequence! <= query.end : Buffer.from(this.store.read(sessionId, e.payloadRef)).toString("utf8").toLowerCase().includes(query.text.toLowerCase())).map(e => json({ eventId: e.id, sequence: e.originalSequence, title: `${e.kind} by ${e.producer}`, ref: e.payloadRef, byteLength: state.artifacts.find(a => a.storageRef === e.payloadRef)?.byteLength, excerpt: Buffer.from(this.store.read(sessionId, e.payloadRef)).toString("utf8").slice(0, 240), historicalObservation: true })));
				// Large discovery results are materialized as an immutable, session-scoped artifact.
				const indexRef = saveJson(this.store, sessionId, candidates);
				update(this.store, sessionId, s => {
					if (!s.artifacts.some(a => a.storageRef === indexRef)) { const bytes = this.store.read(sessionId, indexRef); s.artifacts.push({ id: id("lookup", indexRef), sessionId, hash: hash(bytes), byteLength: bytes.length, storageRef: indexRef, mediaType: "application/json", captureKind: "auxiliary_capture", completeness: "complete", eventIds: [] }); }
				});
				for (const row of candidates) {
					if (this.tokenizer.count(canonical({ results: [...results, row], continuation: { kind: "reference", ref: indexRef, offset: 0 } })) + 32 > limits.tokens) { continuation = { kind: "reference", ref: indexRef, offset: 0 }; break; }
					results.push(row);
				}
			}
			const tokens = this.tokenizer.count(canonical({ results, continuation })) + 32;
			if (tokens > limits.tokens) fail("CONTEXT_BUDGET_EXCEEDED", "Lookup framing exceeds response limit");
			update(this.store, sessionId, s => { s.lookupCount++; });
			return { results, continuation, tokens };
		});
	}
	inspect(sessionId: string) {
		return attempt(() => {
			const state = this.store.load(sessionId).state, storedLedger = state.ledgers.at(-1), ledger = storedLedger ? { ...storedLedger, items: effectiveItems(storedLedger) } : undefined, coverage = validatedWatermark(state);
			const now = this.now(), sealed = state.snapshots.at(-1)?.end ?? 0;
			const buffered = originalEvents(state).slice(sealed);
			const bufferedTokens = buffered.reduce((n, e) => n + (e.tokenizerId === this.tokenizer.id ? e.visibleTokens : this.tokenizer.count(Buffer.from(this.store.read(sessionId, e.payloadRef)).toString("utf8"))), 0);
			const blocks = new Map(currentBlocks(state).map(b => [b.snapshotId, b]));
			const versions = new Map<string, number>(), jobs = new Map(state.jobs.map(j => [j.id, j]));
			for (const block of state.blocks) versions.set(block.snapshotId, (versions.get(block.snapshotId) ?? 0) + 1);
			const memoryBlocks = state.snapshots.map((snapshot, index) => {
				const block = blocks.get(snapshot.id), attempt = block && jobs.get(block.jobId)?.attempts.at(-1);
				return { number: index + 1, snapshotId: snapshot.id, start: snapshot.start, end: snapshot.end, sourceTokens: snapshot.visibleTokens, sealedAt: snapshot.createdAt,
					state: block && snapshot.end <= coverage ? "published" as const : "pending" as const,
					blockId: block?.id, title: block?.title, tokens: block?.tokens, tokenizerId: block?.tokenizerId, versions: versions.get(snapshot.id) ?? 0,
					generatedAt: attempt ? attempt.startedAt + attempt.durationMs : undefined };
			});
			const snapshotProgress = { bufferedEvents: buffered.length, bufferedTokens, target: this.config.snapshotTarget, min: this.config.snapshotMin, max: this.config.snapshotMax,
				tokensToTarget: Math.max(0, this.config.snapshotTarget - bufferedTokens), percent: Math.min(100, Math.floor(bufferedTokens / this.config.snapshotTarget * 100)),
				thresholdReached: bufferedTokens >= this.config.snapshotTarget, tokenizerId: this.tokenizer.id, countingMode: this.tokenizer.mode };
			return { sessionId, observedAt: now, generationAvailable: !!this.generation, memoryBlocks, snapshotProgress, blockMax: this.config.blockMax, retainedBlockVersions: state.blocks.length, currentLedgerVersion: ledger?.version, derivedRevision: state.derivedRevision ?? 0, minimumHandoffCutoff: state.minimumHandoffCutoff ?? 0, aliases: ledger?.aliases ?? [], migrations: state.migrations ?? [], dispatches: state.host?.dispatches ?? [], sourceWatermark: sourceWatermark(state), validatedWatermark: coverage, sealedWatermark: state.snapshots.at(-1)?.end ?? 0, uncoveredTokens: originalEvents(state).filter(e => e.originalSequence! > coverage).reduce((n, e) => n + e.visibleTokens, 0), goals: ledger?.items.filter(i => i.kind === "objective" && OPEN.has(i.status)) ?? [], activeObligations: ledger ? canonicalItems(ledger).filter(i => OPEN.has(i.status)) : [], statusCounts: Object.fromEntries(["active", "deferred", "unresolved", "completed", "cancelled", "superseded"].map(status => [status, ledger?.items.filter(i => i.status === status).length ?? 0])), pendingOperations: ledger?.operations.filter(o => o.status === "running" || o.status === "unknown") ?? [], unresolvedConflicts: ledger?.transitions.filter(t => t.review?.verdict === "ambiguous") ?? [], writerJobs: state.jobs.map(j => ({ id: j.id, kind: j.kind, state: j.state, leaseExpired: j.state === "running" && j.leaseUntil <= now, lastError: j.attempts.at(-1)?.error, attempts: j.attempts.length, repairs: Math.max(0, j.attempts.length - 1), latencyMs: j.attempts.reduce((n, a) => n + a.durationMs, 0), inputTokensCounted: j.attempts.reduce((n, a) => n + (a.inputTokens ?? 0), 0), outputTokensCounted: j.attempts.reduce((n, a) => n + (a.tokens ?? 0), 0), providerUsage: j.attempts.flatMap(a => a.providerUsage ?? []), queueAgeMs: j.state === "running" ? this.now() - (j.attempts[0]?.startedAt ?? this.now()) : 0 })), blockSizes: state.blocks.map(b => ({ id: b.id, tokens: b.tokens })), latestHandoff: state.handoffs.at(-1) ?? null, lookupCount: state.lookupCount, activationConflicts: state.failures.filter(f => f.code === "REVISION_CONFLICT").length, lastFailure: state.failures.at(-1) ?? null, replacementSupported: !!this.host.dispatch };
		});
	}
}
export function formatStatus(status: ReturnType<SessionMemory["inspect"]>): string {
	if (!status.ok) return `${status.code}: ${status.message}`;
	const s = status.value;
	const n = (value: number) => value.toLocaleString("en-US");
	const short = (text: string, limit = 100) => {
		const line = stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
		return line.length > limit ? line.slice(0, limit - 3) + "..." : line;
	};
	const age = (timestamp: number) => { const seconds = Math.max(0, Math.floor((s.observedAt - timestamp) / 1000)); return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`; };
	const pending = s.memoryBlocks.filter(b => b.state === "pending"), published = s.memoryBlocks.length - pending.length;
	const p = s.snapshotProgress, filled = Math.floor(p.percent / 10), unit = p.countingMode === "exact" ? "tokens" : "counted units";
	const running = s.writerJobs.filter(j => j.state === "running" && !j.leaseExpired), expired = s.writerJobs.filter(j => j.leaseExpired), invalid = s.writerJobs.filter(j => j.state === "invalid");
	const visibleJobs = [...running, ...expired, ...invalid.slice(-3).reverse()].slice(0, 3);
	const handoff = s.latestHandoff;
	return [
		`Memory blocks: ${published} published, ${pending.length} awaiting publication. ${s.retainedBlockVersions} stored block versions.`,
		`Next snapshot: [${"#".repeat(filled)}${".".repeat(10 - filled)}] ${n(p.bufferedTokens)} / ${n(p.target)} ${unit}, ${p.percent}% across ${p.bufferedEvents} buffered original events.`,
		p.thresholdReached ? "Snapshot target reached; awaiting the next generation pass." : `${n(p.tokensToTarget)} more ${unit} to the snapshot target.`,
		`Snapshot range: ${n(p.min)}-${n(p.max)} ${unit}. Coherent cuts or forced preparation can seal earlier. No clock-based schedule.`,
		!s.generationAvailable ? "Block generation unavailable: no memory model binding. Sealed snapshots cannot be published as blocks yet." : pending.length ? `Next block: snapshot #${pending[0].number}, originals ${pending[0].start}-${pending[0].end}, awaits extraction, review and publication.` : "Next block: waiting for the next snapshot, then extraction, review and publication.",
		`Jobs: ${running.length} running, ${expired.length} expired leases, ${s.writerJobs.filter(j => j.state === "complete").length} complete, ${invalid.length} invalid.`,
		...visibleJobs.map(j => `  ${j.kind} ${j.leaseExpired ? "lease expired; not confirmed running" : j.state}, ${j.attempts} finished attempts, ${j.repairs} repairs${j.lastError ? `; ${short(j.lastError)}` : ""}`),
		...(s.memoryBlocks.length ? [`Latest ${Math.min(5, s.memoryBlocks.length)} of ${s.memoryBlocks.length} snapshots; block sizes use their recorded counters:`] : ["No snapshots sealed yet."]),
		...s.memoryBlocks.slice(-5).reverse().map(b => b.state === "published"
			? `  #${b.number} published ${b.blockId}, v${b.versions}, ${n(b.tokens!)} units${b.tokenizerId === p.tokenizerId ? ` / ${n(s.blockMax)} cap` : `; counter ${b.tokenizerId}`}, originals ${b.start}-${b.end}${b.generatedAt !== undefined ? `, generated ${age(b.generatedAt)}` : ""}: ${short(b.title ?? "", 64)}`
			: `  #${b.number} pending ${b.snapshotId}, originals ${b.start}-${b.end}, sealed ${age(b.sealedAt)}`),
		`Original events: ${s.sourceWatermark} archived, ${s.sealedWatermark} sealed, ${s.validatedWatermark} validated.`,
		`Active obligations: ${s.activeObligations.length}. Pending operations: ${s.pendingOperations.length}. Conflicts: ${s.unresolvedConflicts.length}.`,
		...s.goals.slice(0, 3).map(i => `Goal: ${short(i.statement)}`),
		handoff ? `Last prepared context: ${n(handoff.rendered.counts.total)} units, ${handoff.selectedBlocks.length} history blocks, ${handoff.continuations.length} continuations, cutoff ${handoff.cutoff}.` : "Last prepared context: none.",
		`Dispatches: ${s.dispatches.filter(d => d.state === "complete").length} complete, ${s.dispatches.filter(d => d.state === "accepted" || d.state === "sent").length} awaiting definite completion.`,
		`Counter: ${p.tokenizerId}${p.countingMode === "conservative" ? "; conservative bound, not measured provider tokens" : ""}.`,
		`Replacement: ${s.replacementSupported ? "host binding available; acceptance gate still required" : "UNSUPPORTED_HOST_CAPABILITY: atomic dispatch binding missing"}`,
		...(s.lastFailure ? [`Last recorded failure: ${s.lastFailure.code}: ${short(s.lastFailure.message, 240)}`] : []),
	].join("\n");
}
