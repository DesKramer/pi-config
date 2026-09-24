import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, fail, hash } from "./storage.ts";
import { releaseGate, type TrialRequest, type TrialResult } from "./evaluation/runner.ts";

export function implementationDigest(): string {
	const root = dirname(fileURLToPath(import.meta.url));
	const files: string[] = [];
	const visit = (directory: string, prefix = "") => { for (const entry of readdirSync(directory, { withFileTypes: true })) { if (entry.isDirectory()) visit(join(directory, entry.name), `${prefix}${entry.name}/`); else if (entry.name.endsWith(".ts")) files.push(prefix + entry.name); } };
	visit(root);
	return digest(files.sort().map(name => [name, hash(readFileSync(join(root, name)))]));
}
export function requireAcceptance(path: string | undefined, modelIdentity: string): void {
	if (!path) fail("UNSUPPORTED_HOST_CAPABILITY", "Set L_MEM_ACCEPTANCE_REPORT to a passing behavioral report for this implementation and main model");
	const report = JSON.parse(readFileSync(resolve(path), "utf8"));
	if (report.schemaVersion !== 2 || report.protocol !== "real-host-checkpoints-v2" || report.errors?.length || report.kind !== "behavioral" || report.implementationDigest !== implementationDigest() || !Array.isArray(report.trials)) fail("UNSUPPORTED_HOST_CAPABILITY", "Behavioral report is absent, stale, or not a real-agent report");
	const trials = report.trials as { request: TrialRequest; result: TrialResult }[];
	const gate = releaseGate(trials);
	if (!gate.enabled) fail("UNSUPPORTED_HOST_CAPABILITY", `Behavioral acceptance failed: ${gate.reasons.slice(0, 4).join("; ")}`);
	for (const trial of trials.filter(t => t.request.strategy === "l-mem")) {
		if (trial.result.mainAgentIdentity !== modelIdentity) fail("UNSUPPORTED_HOST_CAPABILITY", "Acceptance used a different main model");
		for (const ref of [trial.result.traceRef, ...trial.result.graderEvidenceRefs]) readFileSync(ref);
	}
}
