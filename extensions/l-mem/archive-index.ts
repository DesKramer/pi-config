import type { Json, Store } from "./contracts.ts";
import { canonical, fail, saveJson } from "./storage.ts";

/** Immutable typed directory and JSON-lines pages. Normal page reads stay small. */
export function archiveIndex(store: Store, sessionId: string, entries: Json[], maxBytes = 2048): { rootRef: string; refs: string[] } {
	const groups = new Map<string, Json[]>();
	for (const entry of entries) {
		const kind = entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.kind === "string" ? entry.kind : "entry";
		if (!groups.has(kind)) groups.set(kind, []);
		groups.get(kind)!.push(entry);
	}
	const refs: string[] = [], sections: Json[] = [];
	for (const [kind, rows] of groups) {
		const section = indexPages(store, sessionId, rows, maxBytes); refs.push(...section.refs);
		sections.push({ kind: "index_section", entryKind: kind, entries: rows.length, ref: section.rootRef });
	}
	const directory = indexPages(store, sessionId, sections, maxBytes);
	return { rootRef: directory.rootRef, refs: [...directory.refs, ...refs] };
}
function indexPages(store: Store, sessionId: string, entries: Json[], maxBytes = 2048): { rootRef: string; refs: string[] } {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail("INVALID_EVENT", "Invalid index page limit");
	const refs: string[] = [];
	let nextRef: string | null = null, lines: string[] = [];
	const page = (rows: string[]) => [canonical({ kind: "archive_index_page", nextRef }), ...rows].join("\n");
	const fits = (rows: string[]) => Buffer.byteLength(page(rows)) <= maxBytes;
	const flush = () => { nextRef = store.put(sessionId, Buffer.from(page(lines)), "txt"); refs.push(nextRef); lines = []; };
	for (const entry of [...entries].reverse()) {
		let line = canonical(entry);
		if (!fits([line, ...lines]) && lines.length) flush();
		if (!fits([line])) {
			const ref = saveJson(store, sessionId, entry), row = entry as Record<string, Json>;
			refs.push(ref);
			line = canonical({ kind: "oversized_index_entry", entryKind: row.kind, eventId: row.eventId, artifactId: row.artifactId, blockId: row.blockId, itemId: row.itemId, ref, byteLength: Buffer.byteLength(line), readHint: "Read this entry in bounded byte ranges with bash, not a whole-file read." });
			if (!fits([line])) fail("CONTEXT_BUDGET_EXCEEDED", "An archive index reference cannot fit a bounded page");
		}
		lines.unshift(line);
	}
	if (!fits(lines)) fail("CONTEXT_BUDGET_EXCEEDED", "Archive index framing exceeds its page limit");
	flush();
	return { rootRef: nextRef!, refs };
}
