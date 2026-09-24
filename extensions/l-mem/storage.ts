import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync, readFileSync, realpathSync, chmodSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { createRequire } from "node:module";
import type { ErrorCode, Failure, Json, Result, SessionState, Store } from "./contracts.ts";

export class MemoryError extends Error {
	code: ErrorCode;
	constructor(code: ErrorCode, message: string) { super(message); this.code = code; }
}
export function fail(code: ErrorCode, message: string): never { throw new MemoryError(code, message); }
export function failure(error: unknown): Failure {
	const code = error instanceof MemoryError ? error.code : "STORAGE_ERROR";
	return { ok: false, code, message: error instanceof Error ? error.message : String(error), retryable: ["MEMORY_PENDING", "REVISION_CONFLICT", "STORAGE_ERROR"].includes(code) };
}
export function attempt<T>(fn: () => T): Result<T> { try { return { ok: true, value: fn() }; } catch (e) { return failure(e); } }
export function canonical(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		return `{${Object.keys(value).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
	}
	return fail("INVALID_EVENT", "Expected finite, plain JSON data");
}
/** Conversation data cannot close an XML/HTML memory envelope. */
export function escapeData(value: unknown): string { return canonical(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026"); }
export function digest(value: unknown): string { return hash(Buffer.from(canonical(value))); }
export function hash(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
export function id(prefix: string, ...parts: unknown[]): string { return `${prefix}_${digest(parts).slice(0, 24)}`; }
export function json(value: unknown): Json { return JSON.parse(canonical(value)) as Json; }
export function publishedReferences(state: SessionState): Set<string> {
	const refs = new Set<string>();
	const visit = (value: unknown, key = "") => {
		if (typeof value === "string" && /Refs?$/.test(key)) refs.add(value);
		else if (Array.isArray(value)) value.forEach(v => visit(v, key));
		else if (value && typeof value === "object") for (const [name, child] of Object.entries(value)) visit(child, name);
	};
	visit(state); return refs;
}
export function emptyState(sessionId: string): SessionState {
	return { schemaVersion: 2, sessionId, events: [], artifacts: [], snapshots: [], ledgers: [], blocks: [], extractions: [], jobs: [], handoffs: [], activations: [], failures: [], lookupCount: 0 };
}
export function validateState(state: SessionState, sessionId: string): void {
	if (state.schemaVersion !== 2) fail("UNSUPPORTED_SCHEMA", `Unsupported l-mem schema ${state.schemaVersion}`);
	if (state.sessionId !== sessionId) fail("INVALID_REFERENCE", "Session identity mismatch");
	for (const key of ["events", "artifacts", "snapshots", "ledgers", "blocks", "extractions", "jobs", "handoffs", "activations", "failures"] as const) {
		if (!Array.isArray(state[key])) fail("STORAGE_ERROR", `Corrupt ${key}`);
	}
}

/** SQLite is only a storage adapter. Publication uses a CAS of the complete manifest.
 * Payload files become durable first. Unreferenced files are harmless after a crash.
 * No recovery path executes a tool or dispatches a model request.
 */
export type StorageFaultPoint = "payload_written" | "payload_synced" | "payload_linked" | "directory_synced" | "before_manifest_commit" | "after_manifest_commit";
export class SqliteStore implements Store {
	readonly directory: string;
	private db: SqliteDatabase;
	private fault?: (point: StorageFaultPoint) => void;
	constructor(directory: string, fault?: (point: StorageFaultPoint) => void) {
		this.fault = fault;
		let DatabaseSync: typeof SqliteDatabase;
		try { DatabaseSync = (createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof SqliteDatabase }).DatabaseSync; }
		catch { fail("UNSUPPORTED_HOST_CAPABILITY", "SQLite persistence requires a Node runtime with node:sqlite support"); }
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.directory = realpathSync(directory);
		for (const path of [this.directory, dirname(this.directory)]) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
		this.db = new DatabaseSync(join(this.directory, "state.sqlite"));
		chmodSync(join(this.directory, "state.sqlite"), 0o600);
		this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
		const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (version.user_version !== 0 && version.user_version !== 1) {
			this.db.close(); fail("UNSUPPORTED_SCHEMA", `Unsupported database version ${version.user_version}`);
		}
		this.db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL); PRAGMA user_version=1;");
	}
	load(sessionId: string): { revision: number; state: SessionState } {
		const row = this.db.prepare("SELECT revision,payload,digest FROM sessions WHERE id=?").get(sessionId) as { revision: number; payload: string; digest: string } | undefined;
		if (!row) return { revision: 0, state: emptyState(sessionId) };
		if (hash(Buffer.from(row.payload)) !== row.digest) fail("STORAGE_ERROR", "Session manifest digest mismatch");
		const state = JSON.parse(row.payload);
		if (state.schemaVersion === 1) {
			validateState({ ...state, schemaVersion: 2 }, sessionId);
			let owned = !!state.host?.owner;
			if (owned && state.host.owner.hostname === hostname()) { try { process.kill(state.host.owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") owned = false; } }
			if (state.jobs.some((j: { state: string; leaseUntil: number }) => j.state === "running" && j.leaseUntil > Date.now()) || owned) fail("MEMORY_PENDING", "Stop the legacy host and finish or expire its jobs before migrating this archive");
			// Keep the entire old manifest readable. No source ID, payload, evidence,
			// block or historical ledger is rewritten by this structural migration.
			const previousManifestRef = this.put(sessionId, Buffer.from(row.payload), "json");
			const migrated: SessionState = { ...state, schemaVersion: 2, derivedRevision: 0, minimumHandoffCutoff: 0, derivedUpdates: [],
				legacyHandoffIds: state.handoffs.map((h: { id: string }) => h.id), migrations: [{ from: 1, to: 2, previousManifestRef, appliedAt: Date.now() }] };
			if (this.compareAndSwap(sessionId, row.revision, migrated)) return { revision: row.revision + 1, state: migrated };
			return this.load(sessionId);
		}
		validateState(state, sessionId);
		return { revision: row.revision, state };
	}
	compareAndSwap(sessionId: string, expected: number, state: SessionState): boolean {
		validateState(state, sessionId);
		const payload = canonical(state), checksum = hash(Buffer.from(payload));
		this.fault?.("before_manifest_commit");
		const committed = expected === 0
			? this.db.prepare("INSERT OR IGNORE INTO sessions VALUES (?,1,?,?)").run(sessionId, payload, checksum).changes === 1
			: this.db.prepare("UPDATE sessions SET revision=revision+1,payload=?,digest=? WHERE id=? AND revision=?").run(payload, checksum, sessionId, expected).changes === 1;
		this.fault?.("after_manifest_commit");
		return committed;
	}
	put(sessionId: string, bytes: Uint8Array, suffix: "txt" | "json" | "bin"): string {
		const dir = join(this.directory, digest(sessionId));
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const ref = join(dir, `${hash(bytes)}.${suffix}`), temp = join(dir, `.pending-${randomUUID()}`);
		const fd = openSync(temp, "wx", 0o600);
		try { writeFileSync(fd, bytes); this.fault?.("payload_written"); fsyncSync(fd); this.fault?.("payload_synced"); } finally { closeSync(fd); }
		try {
			try { linkSync(temp, ref); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
			this.fault?.("payload_linked");
		} finally { unlinkSync(temp); }
		// Also fsync the root after creating a new session directory.
		for (const path of [dir, this.directory]) { const handle = openSync(path, "r"); try { fsyncSync(handle); } finally { closeSync(handle); } }
		this.fault?.("directory_synced");
		this.read(sessionId, ref); // Verify an existing content-addressed file rather than trusting its name.
		return ref;
	}
	read(sessionId: string, ref: string): Uint8Array {
		const dir = join(this.directory, digest(sessionId));
		if (dirname(resolve(ref)) !== dir || !/^[a-f0-9]{64}\.(txt|json|bin)$/.test(ref.split("/").at(-1) ?? "")) fail("INVALID_REFERENCE", "Reference is outside this session archive");
		try {
			if (realpathSync(ref) !== ref) fail("INVALID_REFERENCE", "Archive references cannot follow symlinks");
			const bytes = readFileSync(ref);
			if (!ref.endsWith(`${hash(bytes)}.${ref.split(".").at(-1)}`)) fail("MISSING_ARTIFACT", "Artifact digest mismatch");
			return bytes;
		} catch (e) { if (e instanceof MemoryError) throw e; return fail("MISSING_ARTIFACT", `Unreadable artifact ${ref}`); }
	}
	close() { this.db.close(); }
}

/** Contract-test adapter. References resolve through read(), not an agent tool. */
export class FakeStore implements Store {
	private rows = new Map<string, { revision: number; state: SessionState }>();
	private blobs = new Map<string, Uint8Array>();
	beforeCommit?: () => void;
	load(sessionId: string) { return structuredClone(this.rows.get(sessionId) ?? { revision: 0, state: emptyState(sessionId) }); }
	compareAndSwap(sessionId: string, expected: number, state: SessionState) {
		this.beforeCommit?.();
		if ((this.rows.get(sessionId)?.revision ?? 0) !== expected) return false;
		validateState(state, sessionId);
		this.rows.set(sessionId, structuredClone({ revision: expected + 1, state })); return true;
	}
	put(sessionId: string, bytes: Uint8Array, suffix: "txt" | "json" | "bin") {
		const ref = `/fake/${digest(sessionId)}/${hash(bytes)}.${suffix}`;
		this.blobs.set(ref, Uint8Array.from(bytes)); return ref;
	}
	read(sessionId: string, ref: string) {
		if (!ref.startsWith(`/fake/${digest(sessionId)}/`)) fail("INVALID_REFERENCE", "Cross-session reference");
		const bytes = this.blobs.get(ref);
		if (!bytes) fail("MISSING_ARTIFACT", ref);
		return Uint8Array.from(bytes);
	}
	remove(ref: string) { this.blobs.delete(ref); }
}

export function update<T>(store: Store, sessionId: string, fn: (state: SessionState) => T): T {
	for (let retry = 0; retry < 20; retry++) {
		const { revision, state } = store.load(sessionId);
		const result = fn(state);
		if (store.compareAndSwap(sessionId, revision, state)) return structuredClone(result);
	}
	return fail("REVISION_CONFLICT", "Concurrent session writes exhausted CAS retries");
}
export function saveJson(store: Store, sessionId: string, value: unknown): string { return store.put(sessionId, Buffer.from(canonical(value)), "json"); }
export function readJson(store: Store, sessionId: string, ref: string): Json { return JSON.parse(Buffer.from(store.read(sessionId, ref)).toString("utf8")) as Json; }
