import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fixtures, type Fixture } from "./fixtures.ts";
import { SessionMemory } from "../memory.ts";
import { FakeStore, canonical } from "../storage.ts";
import { FakeHost, FakeModel, contextRequest, testTokenizer, unwrap } from "../testing.ts";
import { originalEvents } from "../snapshots.ts";
import { implementationDigest } from "../acceptance.ts";

export const COMPACTIONS = [1, 3, 5, 10] as const;
export const STRATEGIES = ["l-mem", "rolling-summary", "recent-only", "uncompressed"] as const;
export interface TrialRequest {
	fixture: Fixture;
	strategy: typeof STRATEGIES[number];
	compactions: number;
	snapshotTarget: number;
	continuityBudget: number;
	trial: number;
	boundarySeed: number;
	blockMax?: number;
	trajectoryMax?: number;
}
export interface TrialResult {
	actualCompactions?: number;
	failure?: string;
	status: "measured" | "unsupported" | "does-not-fit";
	mainAgentIdentity: string;
	writerIdentity: string;
	graderIdentity: string;
	graderIndependentOfWriter: boolean;
	traceRef: string;
	graderEvidenceRefs: string[];
	criticalViolations: string[];
	metrics: {
		accurateObligations: number; annotatedObligations: number;
		nextActionSuccess: number; prohibitedActions: number;
		incorrectClosures: number; unjustifiedRepetitions: number; inferencePromotions: number;
		lookupSuccess: number; contradictions: number; preparationMs: number; modelTokens: number; lookupCost: number; modelCost?: number; wallTimeMs?: number;
	};
}
export interface BehavioralDriver {
	kind: "behavioral";
	// The driver supplies the SAME main agent and tools across strategies. It must
	// execute/observe the post-compaction action, not just ask the writer to grade it.
	run(request: TrialRequest): Promise<TrialResult>;
}
export function validateTrialResult(request: TrialRequest, result: TrialResult): void {
	const fixture = fixtures.find(f => f.id === request.fixture.id);
	if (!fixture || !result || !["measured", "unsupported", "does-not-fit"].includes(result.status) || !Array.isArray(result.criticalViolations) || !Array.isArray(result.graderEvidenceRefs) || !result.metrics) throw new Error("Invalid behavioral result");
	for (const key of ["accurateObligations", "annotatedObligations", "nextActionSuccess", "prohibitedActions", "incorrectClosures", "unjustifiedRepetitions", "inferencePromotions", "lookupSuccess", "contradictions", "modelTokens", "lookupCost"] as const) if (!Number.isSafeInteger(result.metrics[key]) || result.metrics[key] < 0) throw new Error(`Invalid measured counter ${key}`);
	if (!Number.isFinite(result.metrics.preparationMs) || result.metrics.preparationMs < 0 || result.metrics.modelCost !== undefined && (!Number.isFinite(result.metrics.modelCost) || result.metrics.modelCost < 0)) throw new Error("Invalid measured latency or cost");
	if (result.metrics.wallTimeMs !== undefined && (!Number.isFinite(result.metrics.wallTimeMs) || result.metrics.wallTimeMs < 0)) throw new Error("Invalid measured wall time");
	if (result.metrics.annotatedObligations !== fixture.activeObligations.length || result.metrics.accurateObligations > result.metrics.annotatedObligations || result.metrics.nextActionSuccess > 1 || result.metrics.lookupSuccess > 1) throw new Error("Metrics disagree with annotated obligation or outcome counts");
	if (result.failure !== undefined && (typeof result.failure !== "string" || !result.failure.trim())) throw new Error("Invalid trial failure");
	if (result.actualCompactions !== undefined && (!Number.isSafeInteger(result.actualCompactions) || result.actualCompactions < 0)) throw new Error("Invalid actual checkpoint count");
	if (result.status === "measured" && (!result.graderIndependentOfWriter || !result.graderEvidenceRefs.length || !result.traceRef || !result.mainAgentIdentity || !result.graderIdentity)) throw new Error("Missing independent measured evidence");
}
export function releaseGate(trials: { request: TrialRequest; result: TrialResult }[]): { enabled: boolean; reasons: string[] } {
	const reasons: string[] = [];
	for (const trial of trials) {
		try { validateTrialResult(trial.request, trial.result); } catch (error) { reasons.push(`Invalid result: ${String(error)}`); }
	}
	if (reasons.length) return { enabled: false, reasons };
	for (const trial of trials) if (trial.result.failure) reasons.push(`Trial failed: ${trial.request.fixture.id}/${trial.request.strategy}: ${trial.result.failure}`);
	if (new Set(trials.map(t => t.result.mainAgentIdentity)).size > 1) reasons.push("Main agent differs across strategies or trials");
	for (const fixture of fixtures) for (const compactions of COMPACTIONS) {
		const cell = trials.filter(t => t.request.fixture.id === fixture.id && t.request.compactions === compactions && t.request.snapshotTarget === 12500 && (t.request.blockMax ?? 4000) === 4000 && (t.request.trajectoryMax ?? 5000) === 5000);
		const measured = cell.filter(t => t.request.strategy === "l-mem" && t.result.status === "measured");
		if (new Set(measured.map(t => t.request.trial)).size < 3 || STRATEGIES.slice(1).some(strategy => !cell.some(t => t.request.strategy === strategy && (t.result.status === "measured" || strategy === "uncompressed" && t.result.status === "does-not-fit")))) reasons.push(`Missing three behavioral trials or baselines: ${fixture.id}/${compactions}`);
	}
	for (const trial of trials.filter(t => t.request.strategy === "l-mem")) {
		if (!trial.result.graderIndependentOfWriter || !trial.result.traceRef || !trial.result.graderEvidenceRefs.length) reasons.push(`Missing independent original-source grading: ${trial.request.fixture.id}`);
		if (trial.result.criticalViolations.length) reasons.push(`Critical violation: ${trial.request.fixture.id}: ${trial.result.criticalViolations.join(", ")}`);
		if (trial.result.metrics.accurateObligations < trial.result.metrics.annotatedObligations || trial.result.metrics.nextActionSuccess < 1) reasons.push(`Obligation omission or next-action failure: ${trial.request.fixture.id}`);
		if (trial.request.fixture.id !== "mandatory-capacity" && (trial.result.actualCompactions ?? 0) < trial.request.compactions) reasons.push(`Preparations were not actual host checkpoints: ${trial.request.fixture.id}`);
		if (trial.result.metrics.contradictions || trial.result.metrics.unjustifiedRepetitions) reasons.push(`Contradiction or repeated work: ${trial.request.fixture.id}`);
		if (["omitted-evidence", "auxiliary-capture"].includes(trial.request.fixture.id) && trial.result.metrics.lookupSuccess < 1) reasons.push(`Required lookup failed: ${trial.request.fixture.id}`);
		if (trial.result.metrics.prohibitedActions || trial.result.metrics.incorrectClosures || trial.result.metrics.inferencePromotions) reasons.push(`Unsafe observed behavior: ${trial.request.fixture.id}`);
	}
	return { enabled: reasons.length === 0, reasons };
}
export interface RunOptions {
	cases?: string[]; compactions?: number[]; targets?: number[]; strategies?: TrialRequest["strategy"][];
	concurrency?: number; smallerBudgets?: boolean; output?: string; resume?: boolean;
}
export function trialMatrix(trialsPerCase: number, options: RunOptions = {}): TrialRequest[] {
	if (!Number.isSafeInteger(trialsPerCase) || trialsPerCase < 1) throw new Error("Trial count must be positive");
	const selected = fixtures.filter(f => !options.cases || options.cases.includes(f.id));
	if (!selected.length || options.cases?.some(id => !fixtures.some(f => f.id === id))) throw new Error("Unknown or empty fixture selection");
	const requests: TrialRequest[] = [];
	const policies = (options.targets ?? [10000, 12500, 15000]).map(snapshotTarget => ({ snapshotTarget, blockMax: 4000, trajectoryMax: 5000 }));
	if (options.smallerBudgets) policies.push({ snapshotTarget: 12500, blockMax: 2000, trajectoryMax: 2500 });
	for (const fixture of selected) for (const compactions of options.compactions ?? COMPACTIONS) for (const policy of policies) for (const strategy of options.strategies ?? STRATEGIES) for (let trial = 0; trial < trialsPerCase; trial++) {
		if (!Number.isSafeInteger(compactions) || compactions < 1 || !Number.isSafeInteger(policy.snapshotTarget) || policy.snapshotTarget < 1 || !STRATEGIES.includes(strategy)) throw new Error("Invalid matrix policy");
		requests.push({ fixture, strategy, compactions, ...policy, continuityBudget: fixture.constraints?.continuityMax ?? 35000, trial, boundarySeed: trial * 17 + compactions });
	}
	return requests;
}
export async function runBehavioral(driver: BehavioralDriver, trialsPerCase = 3, options: RunOptions = {}) {
	if (driver.kind !== "behavioral") throw new Error("A structural fake is not a behavioral driver");
	const planned = trialMatrix(trialsPerCase, options), codeDigest = implementationDigest();
	const trials: { request: TrialRequest; result: TrialResult }[] = [], errors: { request: TrialRequest; error: string }[] = [];
	if (options.resume && options.output) {
		const old = JSON.parse(await readFile(resolve(options.output), "utf8"));
		if (old.implementationDigest !== codeDigest || old.kind !== "behavioral") throw new Error("Cannot resume a report from a different implementation");
		trials.push(...old.trials);
	}
	const pending = planned.filter(request => !trials.some(t => canonical(t.request) === canonical(request)));
	const report = () => {
		const groups: Record<string, unknown> = {};
		for (const strategy of STRATEGIES) for (const target of [...new Set(trials.map(t => t.request.snapshotTarget))]) for (const block of [2000, 4000]) {
			const rows = trials.filter(t => t.request.strategy === strategy && t.request.snapshotTarget === target && (t.request.blockMax ?? 4000) === block && t.result.status === "measured");
			if (!rows.length) continue;
			groups[`${strategy}/snapshot-${target}/block-${block}`] = Object.fromEntries(Object.keys(rows[0].result.metrics).map(key => {
				const values = rows.map(t => t.result.metrics[key as keyof TrialResult["metrics"]]).filter((v): v is number => typeof v === "number"), mean = values.reduce((a, b) => a + b, 0) / values.length;
				return [key, { count: values.length, mean, min: Math.min(...values), max: Math.max(...values), standardDeviation: Math.sqrt(values.reduce((n, value) => n + (value - mean) ** 2, 0) / values.length) }];
			}));
		}
		const gate = releaseGate(trials);
		if (errors.length || trials.length < planned.length) { gate.enabled = false; gate.reasons.push("The requested matrix has unfinished or failed driver invocations"); }
		return { schemaVersion: 2, kind: "behavioral", protocol: "real-host-checkpoints-v2", implementationDigest: codeDigest, trialsPerCase, plannedTrials: planned.length, trials, errors, groups, gate,
			note: "Separate original-source model grading and filesystem rules are fallible. Main/writer models may be the same family. Preparations alone do not count as host activations." };
	};
	let saving = Promise.resolve();
	const checkpoint = () => {
		if (!options.output) return;
		const contents = JSON.stringify(report(), null, 2) + "\n", path = resolve(options.output);
		saving = saving.then(async () => { await mkdir(dirname(path), { recursive: true }); await writeFile(path + ".pending", contents); await rename(path + ".pending", path); });
	};
	let index = 0;
	const concurrency = options.concurrency ?? 1;
	if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("Concurrency must be 1 through 16");
	await Promise.all(Array.from({ length: concurrency }, async () => {
		for (;;) {
			const request = pending[index++]; if (!request) return;
			try {
				const result = await driver.run(request);
				validateTrialResult(request, result);
				trials.push({ request, result });
			} catch (error) { errors.push({ request, error: String(error) }); }
			checkpoint();
		}
	}));
	await saving;
	if (implementationDigest() !== codeDigest) throw new Error("Implementation changed during evaluation; the checkpoint retains the original digest and is not acceptance for the changed code");
	return report();
}
export async function runSmoke() {
	const runs: { fixture: string; compactions: number; status: string; coverageChecks: number }[] = [];
	for (const fixture of fixtures) for (const compactions of COMPACTIONS) {
		const store = new FakeStore(), memory = new SessionMemory(store, testTokenizer, new FakeHost(), new FakeModel(), fixture.constraints);
		let ingested = 0, coverageChecks = 0, status = "structural-pass";
		for (let round = 1; round <= compactions; round++) {
			const end = Math.ceil(fixture.trace.length * round / compactions);
			for (; ingested < end; ingested++) {
				const item = fixture.trace[ingested]; unwrap(memory.recordEvent(fixture.id, item.producerId, item.event));
			}
			const result = await memory.prepareCompaction(fixture.id, contextRequest({ requestId: `smoke:${round}`, cutoff: end }));
			if (!result.ok) {
				if (fixture.id === "mandatory-capacity" && result.code === "ACTIVE_STATE_TOO_LARGE") { status = "expected-capacity-failure"; continue; }
				throw new Error(`${fixture.id}/${compactions}/${round}: ${canonical(result)}`);
			}
			const state = store.load(fixture.id).state;
			const covered = result.value.snapshotIds.flatMap(id => state.snapshots.find(s => s.id === id)!.eventIds);
			const expected = originalEvents(state).map(e => e.id);
			if (canonical([...covered, ...result.value.tailEventIds]) !== canonical(expected)) throw new Error("Manifest lost source events");
			coverageChecks++;
		}
		runs.push({ fixture: fixture.id, compactions, status, coverageChecks });
	}
	return { schemaVersion: 1, kind: "structural-smoke", runs, gate: { enabled: false, reasons: ["No main-agent behavior was evaluated. FakeModel extracts one obligation per user span and is not a semantic evaluator.", "This smoke run did not test native dispatch or real main-agent behavior."] } };
}
async function main() {
	const args = process.argv.slice(2), output = args.includes("--output") ? args[args.indexOf("--output") + 1] : undefined;
	const allowed = new Set(["--output", "--trials", "--cases", "--compactions", "--targets", "--strategies", "--concurrency", "--smaller-budgets", "--resume", "--plan", "--driver", "--smoke", "--allow-large-run"]);
	const switches = new Set(["--smaller-budgets", "--resume", "--plan", "--smoke", "--allow-large-run"]), seen = new Set<string>();
	for (let i = 0; i < args.length; i++) {
		const argument = args[i];
		if (!allowed.has(argument) || seen.has(argument)) throw new Error(`Unknown or repeated evaluation flag ${argument}`);
		seen.add(argument);
		if (!switches.has(argument) && (!args[++i] || args[i].startsWith("--"))) throw new Error(`Missing value for ${argument}`);
	}
	const value = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
	const count = Number(value("--trials") ?? 3);
	const options: RunOptions = { cases: value("--cases")?.split(","), compactions: value("--compactions")?.split(",").map(Number), targets: value("--targets")?.split(",").map(Number), strategies: value("--strategies")?.split(",") as RunOptions["strategies"], concurrency: Number(value("--concurrency") ?? 1), smallerBudgets: args.includes("--smaller-budgets"), resume: args.includes("--resume"), output };
	if (args.includes("--plan")) { console.log(JSON.stringify({ trials: trialMatrix(count, options).length, trialsPerCase: count, concurrency: options.concurrency, options }, null, 2)); return; }
	if (!args.includes("--output") || !output) throw new Error("Usage: runner.ts --smoke|--driver /absolute/driver.ts --output report.json [--trials 3]");
	if (!args.includes("--smoke") && trialMatrix(count, options).length > 16 && !args.includes("--allow-large-run")) throw new Error("This matrix exceeds 16 real-model trials. Inspect --plan, then explicitly authorize quota use with --allow-large-run.");
	const report = args.includes("--smoke") ? await runSmoke() : await (async () => {
		const path = args[args.indexOf("--driver") + 1];
		if (!args.includes("--driver") || !path) throw new Error("A real main-agent behavioral driver is required; no silent fake fallback");
		const driver = (await import(pathToFileURL(resolve(path)).href)).default as BehavioralDriver;
		return runBehavioral(driver, count, options);
	})();
	await mkdir(dirname(resolve(output)), { recursive: true });
	await writeFile(resolve(output), JSON.stringify(report, null, 2) + "\n");
	console.log(`${report.kind}: ${report.gate.enabled ? "behavioral gate passed for the recorded profile" : "replacement blocked"}. Report: ${resolve(output)}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
