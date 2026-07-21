import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { buildContinuationInstructions, buildCurrentStepProtocol } from "../extensions/pi-workflow/instructions.ts";
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

test("completion renders terminal instructions", () => {
	const workflow = structuredClone(VALID_WORKFLOW);
	workflow.steps.finished.instructions = "Conclude {{artifacts.qa_report}} for {{input.goal}}.";
	let snapshot = createRunSnapshot({ workflow, workflowPath: "sample.yaml", workflowSource: "path", workflowHash: "hash", goal: "ship it", runId: "run-1" });
	snapshot = applyCheckpoint(snapshot, { outcome: "done", artifacts: [{ name: "report", content: "implemented" }] }).snapshot;
	snapshot = applyCheckpoint(snapshot, { outcome: "passed", artifacts: [{ name: "qa_report", content: "all green" }] }).snapshot;
	assert.match(buildContinuationInstructions(snapshot), /Conclude all green for ship it/);
});
