import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ArtifactInput, Json } from "./contracts.ts";
import { canonical, digest, hash, json } from "./storage.ts";

export interface WorkspaceObservation { version: string; complete: boolean; files: { path: string; hash?: string; reason?: string }[] }
/** A bounded content manifest, not a claim that the workspace stayed unchanged
 * throughout a command. No git index, commit, or working file is modified.
 */
export function observeWorkspace(cwd: string): WorkspaceObservation {
	const files: WorkspaceObservation["files"] = []; let bytes = 0, complete = true;
	function visit(directory: string) {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if ([".git", "node_modules"].includes(entry.name)) continue;
			if (files.length >= 2000 || bytes >= 32_000_000) { complete = false; return; }
			const path = join(directory, entry.name), name = relative(cwd, path);
			try {
				if (entry.isDirectory()) { visit(path); continue; }
				const before = lstatSync(path);
				if (!before.isFile() || before.size > 8_000_000) { complete = false; files.push({ path: name, reason: "Not a bounded regular file" }); continue; }
				const content = readFileSync(path), after = lstatSync(path); bytes += content.byteLength;
				if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) complete = false;
				files.push({ path: name, hash: hash(content) });
			} catch { complete = false; files.push({ path: name, reason: "Unreadable during observation" }); }
		}
	}
	try { visit(cwd); } catch { complete = false; }
	return { version: digest({ files, complete }), complete, files };
}
export function fileSnapshot(cwd: string, args: any): ArtifactInput[] {
	if (typeof args?.path !== "string") return [];
	const path = resolve(cwd, args.path.replace(/^@/, ""));
	// Automatic auxiliary capture never follows an argument into unrelated files
	// outside the workspace or follows a symlink. The ordinary tool keeps its own permissions.
	if (isAbsolute(relative(cwd, path)) || relative(cwd, path).startsWith("..")) return [];
	try {
		if (!realpathSync(path).startsWith(realpathSync(cwd) + "/")) return [];
		const stat = lstatSync(path); if (!stat.isFile() || stat.size > 8_000_000) return [];
		const content = readFileSync(path);
		return [{ content: content.toString("base64"), encoding: "base64", mediaType: "application/octet-stream", captureKind: "workspace_snapshot", completeness: "complete", externalLocator: path, versionIdentity: hash(content) }];
	} catch { return []; }
}
export function workspaceArtifacts(before: WorkspaceObservation, after: WorkspaceObservation): ArtifactInput[] {
	return [before, after].map(observation => ({ content: canonical(observation), encoding: "utf8", mediaType: "application/json", captureKind: "workspace_snapshot", completeness: observation.complete ? "complete" : "truncated", versionIdentity: observation.version }));
}
export function executionScope(tool: string, before: WorkspaceObservation, after: WorkspaceObservation, execution?: Json): string {
	return canonical({ tool, execution, before: before.version, after: after.version, boundedManifestComplete: before.complete && after.complete,
		verificationScope: "Observed before/after contents only. Concurrent or external changes during execution are not ruled out. This does not certify whole-feature acceptance.", unchangedAtEndpoints: before.version === after.version });
}
