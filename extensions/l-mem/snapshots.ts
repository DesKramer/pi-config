import type { Config, SessionState, Snapshot, Store, Tokenizer } from "./contracts.ts";
import { digest, fail, id, saveJson } from "./storage.ts";

export function originalEvents(state: SessionState) { return state.events.filter(e => e.origin === "original"); }
export function sourceWatermark(state: SessionState) { return originalEvents(state).length; }
export function validatedWatermark(state: SessionState): number {
	let end = 0;
	for (const snapshot of state.snapshots) {
		if (snapshot.start !== end + 1) break;
		const block = state.blocks.find(b => b.snapshotId === snapshot.id && b.sourceDigest === snapshot.sourceDigest);
		const ledger = state.ledgers.find(l => l.cutoff === snapshot.end && l.version === block?.ledgerVersion);
		const extraction = state.extractions.find(e => e.snapshotId === snapshot.id);
		if (!block || !ledger || !extraction || !extraction.pages.length || !extraction.pages.at(-1)?.complete) break;
		end = snapshot.end;
	}
	return end;
}
export function validateOwnership(state: SessionState): void {
	const events = originalEvents(state);
	let end = 0;
	for (const snapshot of state.snapshots) {
		if (snapshot.sessionId !== state.sessionId || snapshot.start !== end + 1 || snapshot.end < snapshot.start) fail("STORAGE_ERROR", "Noncontiguous snapshot ownership");
		const owned = events.slice(snapshot.start - 1, snapshot.end);
		if (digest(owned) !== snapshot.sourceDigest || digest(owned.map(e => e.id)) !== digest(snapshot.eventIds)) fail("STORAGE_ERROR", "Snapshot source manifest mismatch");
		end = snapshot.end;
	}
	for (const [index, event] of events.entries()) if (event.originalSequence !== index + 1) fail("STORAGE_ERROR", "Noncontiguous original event positions");
}
export function sealSnapshots(state: SessionState, store: Store, config: Config, tokenizer: Tokenizer, now: number, flushThrough?: number): Snapshot[] {
	validateOwnership(state);
	const original = originalEvents(state);
	if (flushThrough !== undefined && (!Number.isSafeInteger(flushThrough) || flushThrough < 0 || flushThrough > original.length)) fail("INVALID_EVENT", "Invalid snapshot cutoff");
	const previousEnd = state.snapshots.at(-1)?.end ?? 0;
	if (flushThrough !== undefined && flushThrough < previousEnd && !state.snapshots.some(s => s.end === flushThrough)) fail("REVISION_CONFLICT", "Cannot split an already sealed snapshot");
	const available = original.slice(previousEnd, flushThrough);
	const sealed: Snapshot[] = [];
	let start = 0;
	while (start < available.length) {
		let count = 0, cursor = start;
		const candidates: { end: number; tokens: number }[] = [];
		while (cursor < available.length) {
			const event = available[cursor];
			const tokens = tokenizer.count(Buffer.from(store.read(state.sessionId, event.payloadRef)).toString("utf8"));
			if (cursor > start && count + tokens > config.snapshotMax) break;
			count += tokens; cursor++;
			if (count >= config.snapshotMin && event.coherentCut) candidates.push({ end: cursor, tokens: count });
			if (count >= config.snapshotMax || (count >= config.snapshotTarget && candidates.length)) break;
		}
		const boundaryForced = cursor < available.length || count >= config.snapshotTarget || flushThrough !== undefined;
		if (!boundaryForced) break;
		let end = cursor;
		if (candidates.length) {
			candidates.sort((a, b) => Math.abs(a.tokens - config.snapshotTarget) - Math.abs(b.tokens - config.snapshotTarget) || a.end - b.end);
			end = candidates[0].end;
		}
		const owned = available.slice(start, end);
		if (!owned.length) fail("STORAGE_ERROR", "Snapshot segmentation made no progress");
		const sourceDigest = digest(owned);
		const visibleTokens = owned.reduce((n, e) => n + tokenizer.count(Buffer.from(store.read(state.sessionId, e.payloadRef)).toString("utf8")), 0);
		const range = { start: owned[0].originalSequence!, end: owned.at(-1)!.originalSequence! };
		const snapshot: Snapshot = {
			sessionId: state.sessionId, id: id("s", state.sessionId, range, sourceDigest, config.version), ...range,
			eventIds: owned.map(e => e.id), sourceDigest,
			manifestRef: saveJson(store, state.sessionId, { schemaVersion: 1, sourceDigest, events: owned }),
			visibleTokens, tokenizerId: tokenizer.id, segmentationVersion: config.version, createdAt: now,
			...(visibleTokens > config.snapshotMax ? { oversizedReason: "single original event exceeds snapshot maximum" } : {}),
		};
		state.snapshots.push(snapshot); sealed.push(snapshot); start = end;
	}
	validateOwnership(state);
	return sealed;
}

/** Segment original UTF-8 text, never summaries. Spans partition the bytes exactly. */
export function textSegments(bytes: Uint8Array, maxTokens: number, tokenizer: Tokenizer) {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const result: { text: string; start: number; end: number }[] = [];
	let from = 0, byteOffset = 0;
	while (from < text.length) {
		let low = from + 1, high = text.length, end = from;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			if (tokenizer.count(text.slice(from, mid)) <= maxTokens) { end = mid; low = mid + 1; } else high = mid - 1;
		}
		if (end < text.length && end > from && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
		if (end === from) fail("CONTEXT_BUDGET_EXCEEDED", "Writer segment cannot hold one Unicode character");
		const slice = text.slice(from, end), length = Buffer.byteLength(slice);
		result.push({ text: slice, start: byteOffset, end: byteOffset + length });
		from = end; byteOffset += length;
	}
	if (!result.length) result.push({ text: "", start: 0, end: 0 });
	return result;
}
