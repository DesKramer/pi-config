import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { buildContinuationInstructions, buildCurrentStepProtocol } from "../extensions/pi-workflow/instructions.ts";
import piWorkflowExtension, { createWorkflowAgentAvailabilityController, getSubagentNames } from "../extensions/pi-workflow/index.ts";
import { applyCheckpoint, createRunSnapshot, persistedSnapshot, restoreSnapshotFromBranch } from "../extensions/pi-workflow/state.ts";
import { extractTemplateRefs, renderTemplate } from "../extensions/pi-workflow/templates.ts";
import type { WorkflowDefinition } from "../extensions/pi-workflow/types.ts";

const require = createRequire(import.meta.url);
let hasYaml = true;
try {
	require.resolve("yaml");
} catch {
	hasYaml = false;
}

const VALID_YAML = `
version: 1
name: sample
description: Sample workflow.
artifacts:
  report:
    type: text
  qa_report:
    type: text
start: first
steps:
  first:
    type: main
    instructions: "Do {{input.goal}}."
    outputs: [report]
    transitions:
      done: qa
  qa:
    type: delegate
    instructions: "Check {{artifacts.report}}"
    delegate:
      agent: qa
      task: "QA {{input.goal}} with {{artifacts.report}}"
    outputs: [qa_report]
    transitions:
      passed: finished
      failed: first
  finished:
    type: end
`;

const VALID_WORKFLOW: WorkflowDefinition = {
	version: 1,
	name: "sample",
	description: "Sample workflow.",
	artifacts: {
		report: { type: "text" },
		qa_report: { type: "text" },
	},
	start: "first",
	steps: {
		first: {
			type: "main",
			instructions: "Do {{input.goal}}.",
			outputs: ["report"],
			transitions: { done: { target: "qa", requireOutputs: true } },
		},
		qa: {
			type: "delegate",
			instructions: "Check {{artifacts.report}}",
			delegate: { agent: "qa", task: "QA {{input.goal}} with {{artifacts.report}}" },
			outputs: ["qa_report"],
			transitions: {
				passed: { target: "finished", requireOutputs: true },
				failed: { target: "first", requireOutputs: true },
			},
		},
		finished: { type: "end" },
	},
};

async function importParser() {
	return import("../extensions/pi-workflow/parser.ts");
}

test("parser accepts strict v1 workflow and computes a hash", { skip: !hasYaml }, async () => {
	const { parseWorkflowYaml } = await importParser();
	const parsed = parseWorkflowYaml(VALID_YAML, { validation: { availableAgents: ["qa"] } });
	assert.equal(parsed.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(parsed.diagnostics, null, 2));
	assert.equal(parsed.workflow?.name, "sample");
	assert.match(parsed.hash ?? "", /^[a-f0-9]{64}$/);
});

test("parser rejects unsafe templates and unknown delegate agents", { skip: !hasYaml }, async () => {
	const { parseWorkflowYaml } = await importParser();
	const parsed = parseWorkflowYaml(VALID_YAML.replace("{{input.goal}}", "{{env.HOME}}"), { validation: { availableAgents: ["other"] } });
	const messages = parsed.diagnostics.map((d) => d.message).join("\n");
	assert.match(messages, /Unsafe template expression/);
	assert.match(messages, /Unknown delegate agent: qa/);
	assert.equal(parsed.workflow, undefined);
});

test("parser reports disabled and unknown delegate agents without accepting either", { skip: !hasYaml }, async () => {
	const { parseWorkflowYaml } = await importParser();
	const yaml = VALID_YAML.replace(
		"agent: qa\n      task: \"QA {{input.goal}} with {{artifacts.report}}\"",
		"tasks:\n        - agent: qa\n          task: Check the report.\n        - agent: ghost\n          task: Check another concern.",
	);
	const parsed = parseWorkflowYaml(yaml, {
		validation: { availableAgents: ["qa"], disabledAgents: ["qa"] },
	});
	const messages = parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
	assert.match(messages, /Disabled delegate agent: qa/);
	assert.match(messages, /Unknown delegate agent: ghost/);
	assert.doesNotMatch(messages, /Unknown delegate agent: qa/);
	assert.equal(parsed.workflow, undefined);
});

test("parser fails closed when the runtime agent registry cannot be validated", { skip: !hasYaml }, async () => {
	const { parseWorkflowYaml } = await importParser();
	const parsed = parseWorkflowYaml(VALID_YAML, {
		validation: { agentRegistryError: "registry bridge failed" },
	});
	assert.equal(parsed.workflow, undefined);
	assert.match(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /Cannot validate delegate agents: registry bridge failed/);
});

test("/workflow run never reparses around disabled or unknown-agent errors", { skip: !hasYaml }, async () => {
	const previousSubagents = (globalThis as any).__pi_subagents;
	const previousWorkflow = (globalThis as any).__pi_workflow;
	const root = mkdtempSync(join(tmpdir(), "pi-workflow-validation-"));
	const workflowDir = join(root, ".pi", "workflows");
	mkdirSync(workflowDir, { recursive: true });
	const workflowName = `qa-validation-${process.pid}-${Date.now()}`;
	writeFileSync(join(workflowDir, `${workflowName}.yaml`), `
version: 1
name: ${workflowName}
description: Validation regression.
artifacts: {}
start: delegate_step
steps:
  delegate_step:
    type: delegate
    instructions: Validate delegates.
    delegate:
      tasks:
        - agent: qa
          task: Check it.
        - agent: ghost
          task: Check it independently.
    transitions:
      done: finished
  finished:
    type: end
`);

	try {
		(globalThis as any).__pi_subagents = {
			listAgents: () => [{ name: "qa", enabled: false, userEnabled: false }],
			setTemporaryAgentRestriction: () => true,
			clearTemporaryAgentRestriction: () => true,
		};
		const commands = new Map<string, any>();
		let sent = false;
		piWorkflowExtension({
			registerCommand: (name: string, command: unknown) => commands.set(name, command),
			registerTool: () => {},
			on: () => {},
			getActiveTools: () => [],
			setActiveTools: () => {},
			appendEntry: () => {},
			sendUserMessage: () => { sent = true; },
			events: { on: () => {}, emit: () => {} },
		} as any);
		const ctx = {
			cwd: root,
			hasUI: false,
			isProjectTrusted: () => true,
			sessionManager: { getBranch: () => [] },
			ui: { notify: () => {} },
		};

		await assert.rejects(
			commands.get("workflow").handler(`run ${workflowName} ship-it`, ctx),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				assert.match(message, /Disabled delegate agent: qa/);
				assert.match(message, /Unknown delegate agent: ghost/);
				return true;
			},
		);
		assert.equal(sent, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
		(globalThis as any).__pi_subagents = previousSubagents;
		(globalThis as any).__pi_workflow = previousWorkflow;
	}
});

test("runtime restriction failure returns a blocking prompt and hard-denies subagent execution", { skip: !hasYaml }, async () => {
	const previousSubagents = (globalThis as any).__pi_subagents;
	const previousWorkflow = (globalThis as any).__pi_workflow;
	const root = mkdtempSync(join(tmpdir(), "pi-workflow-enforcement-"));
	const workflowDir = join(root, ".pi", "workflows");
	mkdirSync(workflowDir, { recursive: true });
	const workflowName = `enforcement-${process.pid}-${Date.now()}`;
	writeFileSync(join(workflowDir, `${workflowName}.yaml`), `
version: 1
name: ${workflowName}
description: Enforcement regression.
artifacts: {}
start: delegate_step
steps:
  delegate_step:
    type: delegate
    instructions: Run the configured check.
    delegate:
      agent: qa
      task: Check the goal.
    transitions:
      done: finished
  finished:
    type: end
`);

	try {
		let rejectRestriction = false;
		let restriction: Set<string> | undefined;
		(globalThis as any).__pi_subagents = {
			listAgents: () => [{ name: "qa", enabled: true, userEnabled: true }],
			setTemporaryAgentRestriction: (_owner: string, allowed: readonly string[]) => {
				if (rejectRestriction) return false;
				restriction = new Set(allowed);
				return true;
			},
			clearTemporaryAgentRestriction: () => {
				restriction = undefined;
				return true;
			},
		};
		const commands = new Map<string, any>();
		const handlers = new Map<string, any>();
		let activeTools: string[] = [];
		piWorkflowExtension({
			registerCommand: (name: string, command: unknown) => commands.set(name, command),
			registerTool: () => {},
			on: (event: string, handler: unknown) => handlers.set(event, handler),
			getActiveTools: () => activeTools,
			setActiveTools: (next: string[]) => { activeTools = next; },
			appendEntry: () => {},
			sendUserMessage: () => {},
		} as any);
		const ctx = {
			cwd: root,
			hasUI: false,
			isProjectTrusted: () => true,
			sessionManager: { getBranch: () => [] },
			ui: { notify: () => {} },
		};

		await commands.get("workflow").handler(`run ${workflowName} ship-it`, ctx);
		assert.deepEqual([...restriction!], ["qa"]);
		assert.equal((globalThis as any).__pi_workflow.canRunAgent("qa").allowed, false, "execution stays closed until the workflow prompt is built");
		const ready = await handlers.get("before_agent_start")({ systemPrompt: "base" }, ctx);
		assert.match(ready.systemPrompt, /ACTIVE PI-WORKFLOW RUN/);
		assert.equal((globalThis as any).__pi_workflow.canRunAgent("qa").allowed, true);
		assert.ok(activeTools.includes("workflow_checkpoint"));

		rejectRestriction = true;
		const blocked = await handlers.get("before_agent_start")({ systemPrompt: "base" }, ctx);
		assert.match(blocked.systemPrompt, /ACTIVE PI-WORKFLOW BLOCKED/);
		assert.match(blocked.systemPrompt, /runtime enforcement failure/);
		assert.equal((globalThis as any).__pi_workflow.canRunAgent("qa").allowed, false);
		assert.equal(activeTools.includes("workflow_checkpoint"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
		(globalThis as any).__pi_subagents = previousSubagents;
		(globalThis as any).__pi_workflow = previousWorkflow;
	}
});

test("an invalid project workflow shadows a valid same-name user workflow", { skip: !hasYaml }, async () => {
	const { loadWorkflowCatalog } = await importParser();
	const root = mkdtempSync(join(tmpdir(), "pi-workflow-shadow-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project", ".pi", "workflows");
	mkdirSync(join(agentDir, "workflows"), { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(agentDir, "workflows", "sample.yaml"), VALID_YAML);
	writeFileSync(join(projectDir, "sample.yaml"), VALID_YAML.replace("agent: qa", "agent: ghost"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const catalog = loadWorkflowCatalog({
			cwd: join(root, "project"),
			projectTrusted: true,
			validation: { availableAgents: ["qa"] },
		});
		assert.equal(catalog.entries.some((entry) => entry.workflow.name === "sample"), false);
		assert.match(catalog.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), /Unknown delegate agent: ghost/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("parser accepts constrained dynamic delegation and terminal instructions", { skip: !hasYaml }, async () => {
	const { parseWorkflowYaml } = await importParser();
	const yaml = VALID_YAML
		.replace("agent: qa\n      task:", "agents: [qa]\n      minCalls: 1\n      maxCalls: 3\n      parallel: true\n      task:")
		.replace("  finished:\n    type: end", "  finished:\n    type: end\n    instructions: Summarize {{artifacts.qa_report}}.");
	const parsed = parseWorkflowYaml(yaml, { validation: { availableAgents: ["qa"] } });
	assert.equal(parsed.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(parsed.diagnostics, null, 2));
	assert.equal(parsed.workflow?.steps.qa.delegate?.maxCalls, 3);
	assert.equal(parsed.workflow?.steps.finished.instructions, "Summarize {{artifacts.qa_report}}.");
});

test("bug-fixing workflow clarifies expected behavior and requires both scouts before implementation", { skip: !hasYaml }, async () => {
	const { parseWorkflowYaml } = await importParser();
	const yaml = readFileSync(new URL("../workflows/bug-fixing.workflow.yaml", import.meta.url), "utf8");
	const parsed = parseWorkflowYaml(yaml, { validation: { availableAgents: ["scout", "worker"] } });
	assert.equal(parsed.diagnostics.filter((d) => d.severity === "error").length, 0, JSON.stringify(parsed.diagnostics, null, 2));
	assert.equal(parsed.workflow?.name, "bug-fixing");
	assert.ok(parsed.workflow);

	let snapshot = createRunSnapshot({ workflow: parsed.workflow, workflowPath: "bug-fixing.workflow.yaml", workflowSource: "path", workflowHash: parsed.hash ?? "hash", goal: "Saving fails", runId: "bug-run" });
	snapshot = applyCheckpoint(snapshot, { outcome: "analyzed", artifacts: [{ name: "bug_analysis", content: "Save path fails" }] }).snapshot;
	snapshot = applyCheckpoint(snapshot, { outcome: "investigated", artifacts: [{ name: "likely_source_context", content: "src/save.ts" }] }).snapshot;
	assert.equal(snapshot.currentStep, "establish_expected_behavior");

	snapshot = applyCheckpoint(snapshot, { outcome: "needs_clarification" }).snapshot;
	assert.equal(snapshot.currentStep, "establish_expected_behavior");

	snapshot = applyCheckpoint(snapshot, { outcome: "established", artifacts: [{ name: "expected_behavior", content: "Save succeeds" }] }).snapshot;
	assert.equal(snapshot.currentStep, "scout_related_areas");
	snapshot = applyCheckpoint(snapshot, { outcome: "investigated", artifacts: [{ name: "related_code_context", content: "tests/save.test.ts" }] }).snapshot;
	assert.equal(snapshot.currentStep, "implement");

	const done = applyCheckpoint(snapshot, { outcome: "fixed", artifacts: [{ name: "fix_summary", content: "Fixed and tested" }] });
	assert.equal(done.snapshot.currentStep, "completed");
	assert.equal(done.snapshot.status, "completed");
});

test("template renderer only expands input.goal and artifacts", () => {
	assert.deepEqual(extractTemplateRefs("A {{input.goal}} B {{artifacts.report}}").map((ref) => ref.expression), ["input.goal", "artifacts.report"]);
	assert.equal(renderTemplate("Goal={{input.goal}} Report={{artifacts.report}}", { goal: "ship", artifacts: { report: "ok" } }), "Goal=ship Report=ok");
	assert.equal(renderTemplate("Missing={{artifacts.nope}}", { goal: "ship", artifacts: {} }), "Missing=[artifact nope is not available yet]");
});

test("state requires declared step outputs before transition", () => {
	const snapshot = createRunSnapshot({ workflow: VALID_WORKFLOW, workflowPath: "sample.yaml", workflowSource: "path", workflowHash: "hash", goal: "ship it", runId: "run-1", now: new Date("2025-01-01T00:00:00Z") });
	assert.throws(() => applyCheckpoint(snapshot, { outcome: "done" }), /requires artifact output/);
	const next = applyCheckpoint(snapshot, { step: "first", outcome: "done", artifacts: [{ name: "report", content: "implemented" }] }, new Date("2025-01-01T00:01:00Z"));
	assert.equal(next.snapshot.currentStep, "qa");
	assert.equal(next.snapshot.artifacts.report, "implemented");
	assert.equal(next.finished, false);
});

test("state completes when a transition reaches an end step", () => {
	let snapshot = createRunSnapshot({ workflow: VALID_WORKFLOW, workflowPath: "sample.yaml", workflowSource: "path", workflowHash: "hash", goal: "ship it", runId: "run-1" });
	snapshot = applyCheckpoint(snapshot, { outcome: "done", artifacts: [{ name: "report", content: "implemented" }] }).snapshot;
	const done = applyCheckpoint(snapshot, { outcome: "passed", artifacts: [{ name: "qa_report", content: "passed" }] });
	assert.equal(done.snapshot.status, "completed");
	assert.equal(done.snapshot.currentStep, "finished");
	assert.equal(done.finished, true);
});

test("transition can waive normal outputs and select a canceled terminal status", () => {
	const workflow = structuredClone(VALID_WORKFLOW);
	workflow.steps.first.transitions = { abort: { target: "finished", requireOutputs: false } };
	workflow.steps.finished.status = "canceled";
	const snapshot = createRunSnapshot({ workflow, workflowPath: "sample.yaml", workflowSource: "path", workflowHash: "hash", goal: "ship it", runId: "run-1" });
	const canceled = applyCheckpoint(snapshot, { outcome: "abort", summary: "User stopped" });
	assert.equal(canceled.snapshot.status, "canceled");
	assert.equal(canceled.events.at(-1)?.kind, "canceled");
});

test("restore converts running snapshots to interrupted without appending", () => {
	const snapshot = createRunSnapshot({ workflow: VALID_WORKFLOW, workflowPath: "sample.yaml", workflowSource: "path", workflowHash: "hash", goal: "ship it", runId: "run-1" });
	const restored = restoreSnapshotFromBranch([{ type: "custom", customType: "pi-workflow", data: persistedSnapshot(snapshot) }]);
	assert.equal(restored?.status, "interrupted");
	assert.match(restored?.pauseReason ?? "", /resume/i);
});

test("current-step protocol includes only referenced available artifacts", () => {
	let snapshot = createRunSnapshot({ workflow: VALID_WORKFLOW, workflowPath: "sample.yaml", workflowSource: "path", workflowHash: "hash", goal: "ship it", runId: "run-1" });
	snapshot = applyCheckpoint(snapshot, { outcome: "done", artifacts: [{ name: "report", content: "implemented" }] }).snapshot;
	snapshot.artifacts.qa_report = "should not be shown yet";
	const protocol = buildCurrentStepProtocol(snapshot);
	assert.match(protocol, /implemented/);
	assert.doesNotMatch(protocol, /should not be shown yet/);
});

test("workflow bridge exposes only enabled agent metadata without caching", () => {
	const previous = (globalThis as any).__pi_subagents;
	try {
		let metadata = [
			{ name: "worker", enabled: true },
			{ name: "qa", enabled: false },
		];
		(globalThis as any).__pi_subagents = { listAgents: () => metadata };
		assert.deepEqual(getSubagentNames(), ["worker"]);
		metadata = [{ name: "qa", enabled: true }];
		assert.deepEqual(getSubagentNames(), ["qa"]);
	} finally {
		(globalThis as any).__pi_subagents = previous;
	}
});

test("workflow bridge failures fail closed", () => {
	const previous = (globalThis as any).__pi_subagents;
	try {
		(globalThis as any).__pi_subagents = { listAgents: () => { throw new Error("bridge failed"); } };
		assert.deepEqual(getSubagentNames(), []);
	} finally {
		(globalThis as any).__pi_subagents = previous;
	}
});

test("workflow restrictions are a separate layer and preserve user changes made while active", () => {
	const previous = (globalThis as any).__pi_subagents;
	try {
		const userAvailability = new Map([
			["qa", true],
			["worker", true],
			["scout", false],
		]);
		let restriction: Set<string> | undefined;
		const effectiveAvailability = () => Object.fromEntries(
			[...userAvailability].map(([name, userEnabled]) => [name, userEnabled && (!restriction || restriction.has(name))]),
		);
		(globalThis as any).__pi_subagents = {
			listAgents: () => [...userAvailability].map(([name, userEnabled]) => ({
				name,
				userEnabled,
				enabled: userEnabled && (!restriction || restriction.has(name)),
			})),
			setTemporaryAgentRestriction: (_owner: string, allowed: readonly string[]) => {
				restriction = new Set(allowed);
				return true;
			},
			clearTemporaryAgentRestriction: () => {
				restriction = undefined;
				return true;
			},
		};
		const controller = createWorkflowAgentAvailabilityController();
		let snapshot = createRunSnapshot({ workflow: VALID_WORKFLOW, workflowPath: "sample.yaml", workflowSource: "path", workflowHash: "hash", goal: "ship it", runId: "run-1" });
		snapshot = applyCheckpoint(snapshot, { outcome: "done", artifacts: [{ name: "report", content: "implemented" }] }).snapshot;
		assert.deepEqual(controller.setSnapshot(snapshot), { ok: true, required: true });
		assert.deepEqual(effectiveAvailability(), { qa: true, worker: false, scout: false });

		userAvailability.set("worker", false);
		userAvailability.set("scout", true);
		assert.deepEqual(effectiveAvailability(), { qa: true, worker: false, scout: false });

		assert.deepEqual(controller.setSnapshot({ ...snapshot, status: "paused" }), { ok: true, required: false });
		assert.deepEqual(effectiveAvailability(), { qa: true, worker: false, scout: true });
		assert.deepEqual(Object.fromEntries(userAvailability), { qa: true, worker: false, scout: true });
	} finally {
		(globalThis as any).__pi_subagents = previous;
	}
});

test("workflow restriction failures fail closed and failed restoration remains retryable", () => {
	const previous = (globalThis as any).__pi_subagents;
	try {
		let restriction: Set<string> | undefined;
		let rejectSet = true;
		let clearFailures = 1;
		(globalThis as any).__pi_subagents = {
			listAgents: () => [
				{ name: "qa", enabled: !restriction || restriction.has("qa") },
				{ name: "worker", enabled: !restriction || restriction.has("worker") },
			],
			setTemporaryAgentRestriction: (_owner: string, allowed: readonly string[]) => {
				if (rejectSet) return false;
				restriction = new Set(allowed);
				return true;
			},
			clearTemporaryAgentRestriction: () => {
				if (clearFailures-- > 0) return false;
				restriction = undefined;
				return true;
			},
		};
		const controller = createWorkflowAgentAvailabilityController();
		let snapshot = createRunSnapshot({ workflow: VALID_WORKFLOW, workflowPath: "sample.yaml", workflowSource: "path", workflowHash: "hash", goal: "ship it", runId: "run-1" });
		snapshot = applyCheckpoint(snapshot, { outcome: "done", artifacts: [{ name: "report", content: "implemented" }] }).snapshot;

		const rejected = controller.setSnapshot(snapshot);
		assert.equal(rejected.required, true);
		assert.equal(rejected.ok, false);
		assert.match(rejected.error ?? "", /rejected/);
		assert.equal(restriction, undefined);

		rejectSet = false;
		assert.equal(controller.setSnapshot(snapshot).ok, true);
		assert.deepEqual([...restriction!], ["qa"]);
		const firstRestore = controller.setSnapshot({ ...snapshot, status: "paused" });
		assert.equal(firstRestore.ok, false);
		assert.notEqual(restriction, undefined, "failed clear must retain retry bookkeeping");
		assert.deepEqual(controller.restore(), { ok: true, required: false });
		assert.equal(restriction, undefined);
	} finally {
		(globalThis as any).__pi_subagents = previous;
	}
});

test("a setter that mutates then throws is still rolled back on retry", () => {
	const previous = (globalThis as any).__pi_subagents;
	try {
		let restriction: Set<string> | undefined;
		let throwAfterSet = true;
		(globalThis as any).__pi_subagents = {
			setTemporaryAgentRestriction: (_owner: string, allowed: readonly string[]) => {
				restriction = new Set(allowed);
				if (throwAfterSet) throw new Error("listener failed");
				return true;
			},
			clearTemporaryAgentRestriction: () => {
				restriction = undefined;
				return true;
			},
		};
		const controller = createWorkflowAgentAvailabilityController();
		let snapshot = createRunSnapshot({ workflow: VALID_WORKFLOW, workflowPath: "sample.yaml", workflowSource: "path", workflowHash: "hash", goal: "ship it", runId: "run-1" });
		snapshot = applyCheckpoint(snapshot, { outcome: "done", artifacts: [{ name: "report", content: "implemented" }] }).snapshot;
		assert.equal(controller.setSnapshot(snapshot).ok, false);
		assert.deepEqual([...restriction!], ["qa"]);
		assert.deepEqual(controller.restore(), { ok: true, required: false });
		assert.equal(restriction, undefined);

		throwAfterSet = false;
		assert.equal(controller.setSnapshot(snapshot).ok, true);
		assert.deepEqual([...restriction!], ["qa"]);
	} finally {
		(globalThis as any).__pi_subagents = previous;
	}
});

test("current-step protocol does not advertise a disabled fixed delegate", () => {
	let snapshot = createRunSnapshot({ workflow: VALID_WORKFLOW, workflowPath: "sample.yaml", workflowSource: "path", workflowHash: "hash", goal: "ship it", runId: "run-1" });
	snapshot = applyCheckpoint(snapshot, { outcome: "done", artifacts: [{ name: "report", content: "implemented" }] }).snapshot;
	const protocol = buildCurrentStepProtocol(snapshot, []);
	assert.doesNotMatch(protocol, /Call this fixed subagent exactly once: qa/);
	assert.doesNotMatch(protocol, /QA ship it with implemented/);
	assert.match(protocol, /configured delegation plan is currently blocked/);
	assert.match(protocol, /requires an unavailable fixed profile/);
});

test("bundled free-form instructions do not leak a disabled profile name", { skip: !hasYaml }, async () => {
	const { parseWorkflowYaml } = await importParser();
	const yaml = readFileSync(new URL("../workflows/feature-implementation.workflow.yaml", import.meta.url), "utf8");
	const parsed = parseWorkflowYaml(yaml, {
		validation: { availableAgents: ["acceptance-criteria", "scout", "worker", "qa"] },
	});
	assert.ok(parsed.workflow);
	const snapshot = createRunSnapshot({ workflow: parsed.workflow, workflowPath: "feature.yaml", workflowSource: "path", workflowHash: parsed.hash ?? "hash", goal: "ship it", runId: "run-1" });
	const protocol = buildCurrentStepProtocol(snapshot, ["scout", "worker", "qa"]);
	assert.doesNotMatch(protocol, /acceptance-criteria/i);
	assert.doesNotMatch(protocol, /Produce concise, testable acceptance criteria/);
	assert.match(protocol, /configured delegation plan is currently blocked/);
});

test("dynamic fan-out keeps call bounds when only one distinct profile is enabled", () => {
	const workflow = structuredClone(VALID_WORKFLOW);
	workflow.steps.qa.instructions = "Ask the scout to inspect one area.\n\nAsk the worker to inspect another area.";
	workflow.steps.qa.delegate = {
		agents: ["scout", "worker"],
		minCalls: 1,
		maxCalls: 4,
		parallel: true,
		guidance: "Give every scout a distinct concern.\n\nThe worker handles a separate concern.",
	};
	let snapshot = createRunSnapshot({ workflow, workflowPath: "sample.yaml", workflowSource: "path", workflowHash: "hash", goal: "ship it", runId: "run-1" });
	snapshot = applyCheckpoint(snapshot, { outcome: "done", artifacts: [{ name: "report", content: "implemented" }] }).snapshot;
	const protocol = buildCurrentStepProtocol(snapshot, ["scout"], ["scout", "worker"]);
	assert.match(protocol, /Allowed subagents for dynamically generated calls: scout/);
	assert.match(protocol, /Desired call count with current availability: 1\.\.4\. Repeated calls to one allowed profile are valid/);
	assert.doesNotMatch(protocol, /\bworker\b/i);
});

test("disabled agent references are removed from main, fixed-task, and terminal free-form text", () => {
	const workflow = structuredClone(VALID_WORKFLOW);
	workflow.steps.first.instructions = "Implement directly.\n\nAsk qa for a second opinion.";
	workflow.steps.qa.instructions = "Run configured reviews.";
	workflow.steps.qa.delegate = {
		tasks: [{ agent: "worker", responsibility: "Coordinate with qa.", task: "Review implementation without qa." }],
	};
	workflow.steps.finished.instructions = "Summarize the result.\n\nMention qa's review.";
	const mainSnapshot = createRunSnapshot({ workflow, workflowPath: "sample.yaml", workflowSource: "path", workflowHash: "hash", goal: "ship it", runId: "run-1" });
	assert.doesNotMatch(buildCurrentStepProtocol(mainSnapshot, ["worker"], ["worker", "qa"]), /\bqa\b/i);

	let delegateSnapshot = applyCheckpoint(mainSnapshot, { outcome: "done", artifacts: [{ name: "report", content: "implemented" }] }).snapshot;
	const delegateProtocol = buildCurrentStepProtocol(delegateSnapshot, ["worker"], ["worker", "qa"]);
	assert.doesNotMatch(delegateProtocol, /Coordinate with qa|without qa/i);
	assert.match(delegateProtocol, /Complete the configured fixed responsibility/);

	delegateSnapshot = applyCheckpoint(delegateSnapshot, { outcome: "passed", artifacts: [{ name: "qa_report", content: "passed" }] }).snapshot;
	const terminal = buildContinuationInstructions(delegateSnapshot, ["worker"], ["worker", "qa"]);
	assert.match(terminal, /Summarize the result/);
	assert.doesNotMatch(terminal, /qa's review/i);
});

test("a fixed task list blocks instead of advertising a partial list", () => {
	const workflow = structuredClone(VALID_WORKFLOW);
	workflow.steps.qa.instructions = "Run both configured reviews.";
	workflow.steps.qa.delegate = {
		tasks: [
			{ agent: "qa", task: "Check behavior." },
			{ agent: "worker", task: "Check implementation." },
		],
		parallel: true,
	};
	let snapshot = createRunSnapshot({ workflow, workflowPath: "sample.yaml", workflowSource: "path", workflowHash: "hash", goal: "ship it", runId: "run-1" });
	snapshot = applyCheckpoint(snapshot, { outcome: "done", artifacts: [{ name: "report", content: "implemented" }] }).snapshot;
	const protocol = buildCurrentStepProtocol(snapshot, ["qa"]);
	assert.doesNotMatch(protocol, /Dispatch all/);
	assert.doesNotMatch(protocol, /Check behavior|Check implementation|\bworker\b/i);
	assert.match(protocol, /do not run a partial fixed task list/);
});

test("completion renders terminal instructions", () => {
	const workflow = structuredClone(VALID_WORKFLOW);
	workflow.steps.finished.instructions = "Conclude {{artifacts.qa_report}} for {{input.goal}}.";
	let snapshot = createRunSnapshot({ workflow, workflowPath: "sample.yaml", workflowSource: "path", workflowHash: "hash", goal: "ship it", runId: "run-1" });
	snapshot = applyCheckpoint(snapshot, { outcome: "done", artifacts: [{ name: "report", content: "implemented" }] }).snapshot;
	snapshot = applyCheckpoint(snapshot, { outcome: "passed", artifacts: [{ name: "qa_report", content: "all green" }] }).snapshot;
	assert.match(buildContinuationInstructions(snapshot), /Conclude all green for ship it/);
});
