import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseDocument } from "yaml";
import { validateWorkflowTemplates } from "./templates.ts";
import type { ArtifactDeclaration, DelegateSpec, Diagnostic, FixedDelegateTask, ParsedWorkflow, ValidationContext, WorkflowCatalogEntry, WorkflowDefinition, WorkflowSource, WorkflowStep } from "./types.ts";

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ALLOWED_TOP = new Set(["version", "name", "description", "artifacts", "start", "steps"]);
const ALLOWED_ARTIFACT = new Set(["type", "description"]);
const ALLOWED_STEP = new Set(["type", "instructions", "delegate", "outputs", "transitions", "status"]);
const ALLOWED_TRANSITION = new Set(["target", "requireOutputs"]);
const ALLOWED_DELEGATE = new Set(["agent", "tasks", "agents", "minCalls", "maxCalls", "parallel", "guidance", "task"]);
const ALLOWED_FIXED_TASK = new Set(["agent", "task", "responsibility"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>, basePath: string): Diagnostic[] {
	return Object.keys(value)
		.filter((key) => !allowed.has(key))
		.map((key) => ({
			severity: "error" as const,
			path: `${basePath}.${key}`,
			message: `Unknown field: ${key}.`,
			suggestion: `Remove this field. Allowed fields here: ${[...allowed].join(", ")}.`,
		}));
}

function requireString(value: unknown, p: string, diagnostics: Diagnostic[]): string | undefined {
	if (typeof value === "string" && value.trim().length > 0) return value;
	diagnostics.push({ severity: "error", path: p, message: "Expected a non-empty string." });
	return undefined;
}

function validateId(id: string, p: string, diagnostics: Diagnostic[], label = "identifier"): void {
	if (!ID_RE.test(id)) {
		diagnostics.push({
			severity: "error",
			path: p,
			message: `Invalid ${label}: ${id}.`,
			suggestion: "Use letters, numbers, underscores, or dashes, and start with a letter.",
		});
	}
}

function normalizeStringArray(value: unknown, p: string, diagnostics: Diagnostic[]): string[] | undefined {
	if (!Array.isArray(value)) {
		diagnostics.push({ severity: "error", path: p, message: "Expected an array of strings." });
		return undefined;
	}
	const out: string[] = [];
	for (let i = 0; i < value.length; i++) {
		if (typeof value[i] !== "string" || value[i].trim().length === 0) {
			diagnostics.push({ severity: "error", path: `${p}[${i}]`, message: "Expected a non-empty string." });
			continue;
		}
		out.push(value[i]);
	}
	return out;
}

function normalizeArtifacts(value: unknown, diagnostics: Diagnostic[]): Record<string, ArtifactDeclaration> | undefined {
	if (!isRecord(value)) {
		diagnostics.push({ severity: "error", path: "artifacts", message: "Expected an object keyed by artifact name." });
		return undefined;
	}
	const artifacts: Record<string, ArtifactDeclaration> = {};
	for (const [name, rawDecl] of Object.entries(value)) {
		validateId(name, `artifacts.${name}`, diagnostics, "artifact name");
		if (!isRecord(rawDecl)) {
			diagnostics.push({ severity: "error", path: `artifacts.${name}`, message: "Expected artifact declaration object with type: text." });
			continue;
		}
		diagnostics.push(...unknownKeys(rawDecl, ALLOWED_ARTIFACT, `artifacts.${name}`));
		if (rawDecl.type !== "text") {
			diagnostics.push({
				severity: "error",
				path: `artifacts.${name}.type`,
				message: "Only text artifacts are supported.",
				suggestion: "Set type: text. Binary files, paths, and executable artifact declarations are intentionally unsupported.",
			});
			continue;
		}
		const description = rawDecl.description === undefined ? undefined : requireString(rawDecl.description, `artifacts.${name}.description`, diagnostics);
		artifacts[name] = description ? { type: "text", description } : { type: "text" };
	}
	return artifacts;
}

function optionalPositiveInteger(value: unknown, p: string, diagnostics: Diagnostic[]): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	diagnostics.push({ severity: "error", path: p, message: "Expected a positive integer." });
	return undefined;
}

function normalizeFixedTasks(value: unknown, p: string, diagnostics: Diagnostic[]): FixedDelegateTask[] | undefined {
	if (!Array.isArray(value) || value.length === 0) {
		diagnostics.push({ severity: "error", path: p, message: "Expected a non-empty array of fixed delegate tasks." });
		return undefined;
	}
	const tasks: FixedDelegateTask[] = [];
	for (let i = 0; i < value.length; i++) {
		const raw = value[i];
		const itemPath = `${p}[${i}]`;
		if (!isRecord(raw)) {
			diagnostics.push({ severity: "error", path: itemPath, message: "Expected a fixed task object." });
			continue;
		}
		diagnostics.push(...unknownKeys(raw, ALLOWED_FIXED_TASK, itemPath));
		const agent = requireString(raw.agent, `${itemPath}.agent`, diagnostics);
		const task = requireString(raw.task, `${itemPath}.task`, diagnostics);
		const responsibility = raw.responsibility === undefined ? undefined : requireString(raw.responsibility, `${itemPath}.responsibility`, diagnostics);
		if (agent && task) {
			validateId(agent, `${itemPath}.agent`, diagnostics, "agent name");
			tasks.push({ agent, task, ...(responsibility ? { responsibility } : {}) });
		}
	}
	return tasks;
}

function normalizeDelegate(value: unknown, p: string, diagnostics: Diagnostic[]): DelegateSpec | undefined {
	if (!isRecord(value)) {
		diagnostics.push({ severity: "error", path: p, message: "Expected delegate object." });
		return undefined;
	}
	diagnostics.push(...unknownKeys(value, ALLOWED_DELEGATE, p));
	const delegate: DelegateSpec = {};
	if (value.agent !== undefined) delegate.agent = requireString(value.agent, `${p}.agent`, diagnostics);
	if (value.tasks !== undefined) delegate.tasks = normalizeFixedTasks(value.tasks, `${p}.tasks`, diagnostics);
	if (value.agents !== undefined) {
		const agents = normalizeStringArray(value.agents, `${p}.agents`, diagnostics);
		if (agents) delegate.agents = agents;
	}
	delegate.minCalls = optionalPositiveInteger(value.minCalls, `${p}.minCalls`, diagnostics);
	delegate.maxCalls = optionalPositiveInteger(value.maxCalls, `${p}.maxCalls`, diagnostics);
	if (value.parallel !== undefined) {
		if (typeof value.parallel === "boolean") delegate.parallel = value.parallel;
		else diagnostics.push({ severity: "error", path: `${p}.parallel`, message: "Expected a boolean." });
	}
	if (value.guidance !== undefined) delegate.guidance = requireString(value.guidance, `${p}.guidance`, diagnostics);
	if (value.task !== undefined) delegate.task = requireString(value.task, `${p}.task`, diagnostics);

	const forms = Number(!!delegate.agent) + Number(!!delegate.tasks?.length) + Number(!!delegate.agents?.length);
	if (forms !== 1) {
		diagnostics.push({
			severity: "error",
			path: p,
			message: "Delegate steps must specify exactly one of delegate.agent, delegate.tasks, or delegate.agents.",
			suggestion: "Use agent for one fixed call, tasks for a fixed task list, or agents for constrained dynamic delegation.",
		});
	}
	if (!delegate.agents?.length && (delegate.minCalls !== undefined || delegate.maxCalls !== undefined)) {
		diagnostics.push({ severity: "error", path: p, message: "minCalls and maxCalls apply only to dynamic delegate.agents." });
	}
	if (delegate.minCalls !== undefined && delegate.maxCalls !== undefined && delegate.minCalls > delegate.maxCalls) {
		diagnostics.push({ severity: "error", path: `${p}.minCalls`, message: "minCalls may not exceed maxCalls." });
	}
	if (delegate.agents) {
		for (let i = 0; i < delegate.agents.length; i++) validateId(delegate.agents[i], `${p}.agents[${i}]`, diagnostics, "agent name");
	}
	if (delegate.agent) validateId(delegate.agent, `${p}.agent`, diagnostics, "agent name");
	return delegate;
}

function normalizeTransitions(value: unknown, p: string, diagnostics: Diagnostic[]): WorkflowStep["transitions"] {
	if (!isRecord(value)) {
		diagnostics.push({ severity: "error", path: p, message: "Expected transitions object keyed by symbolic outcome." });
		return undefined;
	}
	const transitions: NonNullable<WorkflowStep["transitions"]> = {};
	for (const [outcome, rawTransition] of Object.entries(value)) {
		const transitionPath = `${p}.${outcome}`;
		validateId(outcome, transitionPath, diagnostics, "outcome name");
		if (typeof rawTransition === "string" && rawTransition.trim().length > 0) {
			transitions[outcome] = { target: rawTransition, requireOutputs: true };
			continue;
		}
		if (!isRecord(rawTransition)) {
			diagnostics.push({ severity: "error", path: transitionPath, message: "Transition must be a step id string or { target, requireOutputs } object." });
			continue;
		}
		diagnostics.push(...unknownKeys(rawTransition, ALLOWED_TRANSITION, transitionPath));
		const target = requireString(rawTransition.target, `${transitionPath}.target`, diagnostics);
		const requireOutputs = rawTransition.requireOutputs === undefined ? true : rawTransition.requireOutputs;
		if (typeof requireOutputs !== "boolean") diagnostics.push({ severity: "error", path: `${transitionPath}.requireOutputs`, message: "Expected a boolean." });
		if (target && typeof requireOutputs === "boolean") transitions[outcome] = { target, requireOutputs };
	}
	return transitions;
}

function normalizeStep(rawStep: unknown, stepId: string, diagnostics: Diagnostic[]): WorkflowStep | undefined {
	const basePath = `steps.${stepId}`;
	if (!isRecord(rawStep)) {
		diagnostics.push({ severity: "error", path: basePath, message: "Expected step object." });
		return undefined;
	}
	diagnostics.push(...unknownKeys(rawStep, ALLOWED_STEP, basePath));
	if (rawStep.type !== "main" && rawStep.type !== "delegate" && rawStep.type !== "end") {
		diagnostics.push({ severity: "error", path: `${basePath}.type`, message: "Step type must be one of: main, delegate, end." });
		return undefined;
	}

	const step: WorkflowStep = { type: rawStep.type };
	if (rawStep.instructions !== undefined) step.instructions = requireString(rawStep.instructions, `${basePath}.instructions`, diagnostics);
	if (rawStep.delegate !== undefined) step.delegate = normalizeDelegate(rawStep.delegate, `${basePath}.delegate`, diagnostics);
	if (rawStep.outputs !== undefined) {
		const outputs = normalizeStringArray(rawStep.outputs, `${basePath}.outputs`, diagnostics);
		if (outputs) step.outputs = outputs;
	}
	if (rawStep.transitions !== undefined) step.transitions = normalizeTransitions(rawStep.transitions, `${basePath}.transitions`, diagnostics);
	if (rawStep.status !== undefined) {
		if (rawStep.status === "completed" || rawStep.status === "canceled" || rawStep.status === "failed") step.status = rawStep.status;
		else diagnostics.push({ severity: "error", path: `${basePath}.status`, message: "End status must be one of: completed, canceled, failed." });
	}

	if (step.type === "end") {
		if (step.delegate !== undefined) diagnostics.push({ severity: "error", path: `${basePath}.delegate`, message: "End steps may not delegate." });
		if (step.outputs?.length) diagnostics.push({ severity: "error", path: `${basePath}.outputs`, message: "End steps may not require outputs." });
		if (step.transitions && Object.keys(step.transitions).length > 0) diagnostics.push({ severity: "error", path: `${basePath}.transitions`, message: "End steps may not have transitions." });
		return step;
	}

	if (step.status !== undefined) diagnostics.push({ severity: "error", path: `${basePath}.status`, message: "Only end steps may define terminal status." });
	if (!step.instructions) diagnostics.push({ severity: "error", path: `${basePath}.instructions`, message: `${step.type} steps require instructions.` });
	if (step.type === "delegate" && !step.delegate) diagnostics.push({ severity: "error", path: `${basePath}.delegate`, message: "Delegate steps require delegate configuration." });
	if (step.type === "main" && step.delegate) diagnostics.push({ severity: "error", path: `${basePath}.delegate`, message: "Only delegate steps may define delegate configuration." });
	if (!step.transitions || Object.keys(step.transitions).length === 0) diagnostics.push({ severity: "error", path: `${basePath}.transitions`, message: `${step.type} steps require at least one transition outcome.` });
	return step;
}

function normalizeWorkflow(raw: unknown, context: ValidationContext = {}): { workflow?: WorkflowDefinition; diagnostics: Diagnostic[] } {
	const diagnostics: Diagnostic[] = [];
	if (!isRecord(raw)) {
		return { diagnostics: [{ severity: "error", path: "$", message: "Workflow YAML must be a mapping/object." }] };
	}
	diagnostics.push(...unknownKeys(raw, ALLOWED_TOP, "$"));

	if (raw.version !== 1) diagnostics.push({ severity: "error", path: "version", message: "Workflow version must be exactly 1." });
	const name = requireString(raw.name, "name", diagnostics);
	if (name) validateId(name, "name", diagnostics, "workflow name");
	const description = requireString(raw.description, "description", diagnostics);
	const start = requireString(raw.start, "start", diagnostics);
	if (start) validateId(start, "start", diagnostics, "start step id");
	const artifacts = normalizeArtifacts(raw.artifacts, diagnostics);

	const steps: Record<string, WorkflowStep> = {};
	if (!isRecord(raw.steps)) {
		diagnostics.push({ severity: "error", path: "steps", message: "Expected object keyed by step id." });
	} else {
		for (const [stepId, rawStep] of Object.entries(raw.steps)) {
			validateId(stepId, `steps.${stepId}`, diagnostics, "step id");
			const step = normalizeStep(rawStep, stepId, diagnostics);
			if (step) steps[stepId] = step;
		}
	}

	if (diagnostics.some((d) => d.severity === "error") || !name || !description || !start || !artifacts || Object.keys(steps).length === 0) {
		return { diagnostics };
	}

	const workflow: WorkflowDefinition = { version: 1, name, description, artifacts, start, steps };
	diagnostics.push(...validateWorkflowDefinition(workflow, context));
	return { workflow: diagnostics.some((d) => d.severity === "error") ? undefined : workflow, diagnostics };
}

export function validateWorkflowDefinition(workflow: WorkflowDefinition, context: ValidationContext = {}): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const stepIds = new Set(Object.keys(workflow.steps));
	const artifactIds = new Set(Object.keys(workflow.artifacts));

	if (!stepIds.has(workflow.start)) {
		diagnostics.push({ severity: "error", path: "start", message: `Start step does not exist: ${workflow.start}.` });
	} else if (workflow.steps[workflow.start]?.type === "end") {
		diagnostics.push({ severity: "error", path: "start", message: "Start step may not be an end step." });
	}

	for (const [stepId, step] of Object.entries(workflow.steps)) {
		for (const output of step.outputs ?? []) {
			if (!artifactIds.has(output)) diagnostics.push({ severity: "error", path: `steps.${stepId}.outputs`, message: `Output references undeclared artifact: ${output}.` });
		}
		for (const [outcome, transition] of Object.entries(step.transitions ?? {})) {
			if (!stepIds.has(transition.target)) diagnostics.push({ severity: "error", path: `steps.${stepId}.transitions.${outcome}`, message: `Transition target does not exist: ${transition.target}.` });
		}
		if (step.type === "delegate" && step.delegate && context.availableAgents) {
			const available = new Set(context.availableAgents);
			const names = step.delegate.agent
				? [step.delegate.agent]
				: step.delegate.tasks?.map((task) => task.agent) ?? step.delegate.agents ?? [];
			for (const name of names) {
				if (!available.has(name)) {
					diagnostics.push({
						severity: "error",
						path: `steps.${stepId}.delegate`,
						message: `Unknown delegate agent: ${name}.`,
						suggestion: `Install/register that subagent or use one of: ${context.availableAgents.join(", ") || "(none available)"}.`,
					});
				}
			}
		}
	}

	diagnostics.push(...validateWorkflowTemplates(workflow));
	diagnostics.push(...validateGraph(workflow));
	return diagnostics;
}

function validateGraph(workflow: WorkflowDefinition): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const reachable = new Set<string>();
	const stack = [workflow.start];
	while (stack.length > 0) {
		const stepId = stack.pop()!;
		if (reachable.has(stepId)) continue;
		reachable.add(stepId);
		const step = workflow.steps[stepId];
		if (!step) continue;
		for (const transition of Object.values(step.transitions ?? {})) stack.push(transition.target);
	}
	for (const stepId of Object.keys(workflow.steps)) {
		if (!reachable.has(stepId)) diagnostics.push({ severity: "error", path: `steps.${stepId}`, message: "Step is unreachable from start." });
	}

	const memo = new Map<string, boolean>();
	const visiting = new Set<string>();
	function canReachEnd(stepId: string): boolean {
		if (memo.has(stepId)) return memo.get(stepId)!;
		const step = workflow.steps[stepId];
		if (!step) return false;
		if (step.type === "end") return true;
		if (visiting.has(stepId)) return false;
		visiting.add(stepId);
		const result = Object.values(step.transitions ?? {}).some((transition) => canReachEnd(transition.target));
		visiting.delete(stepId);
		memo.set(stepId, result);
		return result;
	}
	for (const stepId of reachable) {
		if (!canReachEnd(stepId)) diagnostics.push({ severity: "error", path: `steps.${stepId}`, message: "No path from this step to an end step." });
	}
	return diagnostics;
}

export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function workflowHash(workflow: WorkflowDefinition): string {
	return createHash("sha256").update(stableStringify(workflow)).digest("hex");
}

export function parseWorkflowYaml(content: string, options: { path?: string; source?: WorkflowSource; validation?: ValidationContext } = {}): ParsedWorkflow {
	const diagnostics: Diagnostic[] = [];
	let raw: unknown;
	try {
		const doc = parseDocument(content, { strict: true, uniqueKeys: true });
		for (const err of doc.errors ?? []) diagnostics.push({ severity: "error", path: options.path ?? "$", message: err.message });
		for (const warning of doc.warnings ?? []) diagnostics.push({ severity: "warning", path: options.path ?? "$", message: warning.message });
		if (diagnostics.some((d) => d.severity === "error")) return { diagnostics, path: options.path, source: options.source };
		raw = doc.toJSON();
	} catch (error) {
		diagnostics.push({ severity: "error", path: options.path ?? "$", message: error instanceof Error ? error.message : String(error) });
		return { diagnostics, path: options.path, source: options.source };
	}

	const normalized = normalizeWorkflow(raw, options.validation ?? {});
	diagnostics.push(...normalized.diagnostics);
	if (diagnostics.some((d) => d.severity === "error") || !normalized.workflow) {
		return { diagnostics, path: options.path, source: options.source };
	}
	const hash = workflowHash(normalized.workflow);
	return { workflow: normalized.workflow, diagnostics, path: options.path, source: options.source, hash };
}

export function parseWorkflowFile(filePath: string, source: WorkflowSource = "path", validation: ValidationContext = {}): ParsedWorkflow {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return parseWorkflowYaml(content, { path: filePath, source, validation });
	} catch (error) {
		return {
			path: filePath,
			source,
			diagnostics: [{ severity: "error", path: filePath, message: `Could not read workflow file: ${error instanceof Error ? error.message : String(error)}` }],
		};
	}
}

export function findNearestProjectWorkflowsDir(cwd: string, configDirName = ".pi"): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, configDirName, "workflows");
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function discoverWorkflowFiles(dir: string): string[] {
	if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
	return fs.readdirSync(dir)
		.filter((entry) => /\.(ya?ml)$/i.test(entry))
		.sort((a, b) => a.localeCompare(b))
		.map((entry) => path.join(dir, entry));
}

export interface WorkflowCatalog {
	entries: WorkflowCatalogEntry[];
	diagnostics: Diagnostic[];
	userDir: string;
	projectDir?: string;
}

export function loadWorkflowCatalog(options: { cwd: string; projectTrusted: boolean; validation?: ValidationContext; configDirName?: string }): WorkflowCatalog {
	const userDir = path.join(getAgentDir(), "workflows");
	const projectDir = options.projectTrusted ? findNearestProjectWorkflowsDir(options.cwd, options.configDirName ?? ".pi") : undefined;
	const diagnostics: Diagnostic[] = [];
	const byName = new Map<string, WorkflowCatalogEntry>();
	const seenBySource = new Map<string, string>();

	function addFile(filePath: string, source: WorkflowSource): void {
		const parsed = parseWorkflowFile(filePath, source, options.validation ?? {});
		diagnostics.push(...parsed.diagnostics.map((d) => ({ ...d, path: d.path || filePath })));
		if (!parsed.workflow || !parsed.hash) return;
		const key = `${source}:${parsed.workflow.name}`;
		const priorSameSource = seenBySource.get(key);
		if (priorSameSource) {
			diagnostics.push({ severity: "error", path: filePath, message: `Duplicate ${source} workflow name: ${parsed.workflow.name}.`, suggestion: `Rename one of: ${priorSameSource} or ${filePath}.` });
			return;
		}
		seenBySource.set(key, filePath);
		byName.set(parsed.workflow.name, {
			workflow: parsed.workflow,
			path: filePath,
			source,
			hash: parsed.hash,
			diagnostics: parsed.diagnostics,
		});
	}

	for (const file of discoverWorkflowFiles(userDir)) addFile(file, "user");
	if (projectDir) {
		for (const file of discoverWorkflowFiles(projectDir)) addFile(file, "project");
	}

	return { entries: [...byName.values()].sort((a, b) => a.workflow.name.localeCompare(b.workflow.name)), diagnostics, userDir, projectDir };
}

export function formatDiagnostics(diagnostics: Diagnostic[]): string {
	if (diagnostics.length === 0) return "No diagnostics.";
	return diagnostics.map((d) => `${d.severity.toUpperCase()} ${d.path}: ${d.message}${d.suggestion ? `\n  Fix: ${d.suggestion}` : ""}`).join("\n");
}
