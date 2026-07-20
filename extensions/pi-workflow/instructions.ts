import { referencedArtifactsForStep, renderTemplate } from "./templates.ts";
import type { WorkflowSnapshot, WorkflowStep } from "./types.ts";

function currentStep(snapshot: WorkflowSnapshot): { id: string; step: WorkflowStep } {
	const id = snapshot.currentStep;
	if (!id) throw new Error("Workflow has no current step.");
	const step = snapshot.workflow.steps[id];
	if (!step) throw new Error(`Workflow current step does not exist: ${id}.`);
	return { id, step };
}

function renderOptional(template: string | undefined, snapshot: WorkflowSnapshot): string | undefined {
	return template ? renderTemplate(template, { goal: snapshot.goal, artifacts: snapshot.artifacts }) : undefined;
}

export function referencedArtifactBlock(snapshot: WorkflowSnapshot, step: WorkflowStep): string {
	const refs = referencedArtifactsForStep(step).filter((name) => snapshot.artifacts[name] !== undefined);
	if (refs.length === 0) return "Referenced artifacts for this step: none.";
	return [
		"Referenced artifacts for this step only:",
		...refs.map((name) => `\n--- artifact:${name} ---\n${snapshot.artifacts[name]}`),
	].join("\n");
}

export function buildCurrentStepProtocol(snapshot: WorkflowSnapshot): string {
	const { id, step } = currentStep(snapshot);
	const renderedInstructions = renderOptional(step.instructions, snapshot) ?? "";
	const outcomes = Object.keys(step.transitions ?? {});
	const outputs = step.outputs ?? [];
	const parts: string[] = [];

	parts.push(`ACTIVE PI-WORKFLOW RUN: ${snapshot.workflowName}`);
	parts.push("This workflow owns the session until it is paused, canceled, or completed. Keep the conversation focused on the workflow goal; defer unrelated work unless needed to finish the current step.");
	parts.push(`Run id: ${snapshot.runId}`);
	parts.push(`Pinned workflow hash: ${snapshot.workflowHash}`);
	parts.push(`Goal: ${snapshot.goal}`);
	parts.push(`Current step: ${id} (${step.type})`);
	parts.push("Current step instructions:");
	parts.push(renderedInstructions.trim());

	if (step.type === "delegate" && step.delegate) {
		parts.push("Delegate guidance (prompt-only; the workflow engine does not inspect or enforce subagent calls):");
		if (step.delegate.agent) parts.push(`- Fixed subagent: ${step.delegate.agent}`);
		if (step.delegate.tasks?.length) {
			parts.push(`- Dispatch all ${step.delegate.tasks.length} fixed task(s)${step.delegate.parallel === true ? " in parallel" : step.delegate.parallel === false ? " sequentially" : ""}:`);
			for (const fixed of step.delegate.tasks) {
				const responsibility = renderOptional(fixed.responsibility, snapshot);
				const task = renderOptional(fixed.task, snapshot) ?? fixed.task;
				parts.push(`  - ${fixed.agent}${responsibility ? ` — responsibility: ${responsibility}` : ""}\n    Task: ${task}`);
			}
		}
		if (step.delegate.agents?.length) {
			parts.push(`- Allowed subagents for dynamically generated calls: ${step.delegate.agents.join(", ")}`);
			if (step.delegate.minCalls !== undefined || step.delegate.maxCalls !== undefined) {
				parts.push(`- Desired call count: ${step.delegate.minCalls ?? 1}..${step.delegate.maxCalls ?? "unbounded"}.`);
			}
			if (step.delegate.parallel !== undefined) parts.push(`- Dispatch ${step.delegate.parallel ? "in parallel where independent" : "sequentially"}.`);
		}
		const guidance = renderOptional(step.delegate.guidance, snapshot);
		if (guidance) parts.push(guidance.trim());
		const task = renderOptional(step.delegate.task, snapshot);
		if (task) parts.push(`Suggested subagent task template:\n${task.trim()}`);
		parts.push("Include all relevant context in every subagent task. You must summarize useful results and failures in the checkpoint.");
	}

	parts.push(referencedArtifactBlock(snapshot, step));
	parts.push("Checkpoint protocol:");
	parts.push(`- Complete only the current step, then call workflow_checkpoint.`);
	parts.push(`- workflow_checkpoint.step should be \"${id}\" (or omit it).`);
	parts.push(`- Allowed outcomes: ${outcomes.join(", ") || "none"}.`);
	parts.push(`- Required text artifact outputs for this step: ${outputs.join(", ") || "none"}.`);
	parts.push("- Include summary and evidence when useful. Include artifacts as [{name, content}] text only. Do not proceed to the next workflow step until the tool returns continuation instructions.");

	return parts.filter(Boolean).join("\n\n");
}

export function buildContinuationInstructions(snapshot: WorkflowSnapshot): string {
	if (snapshot.status === "completed" || snapshot.status === "canceled" || snapshot.status === "failed") {
		const endStep = snapshot.currentStep ? snapshot.workflow.steps[snapshot.currentStep] : undefined;
		const terminal = endStep?.type === "end" ? renderOptional(endStep.instructions, snapshot)?.trim() : undefined;
		return [`Workflow ${snapshot.workflowName} is ${snapshot.status}.`, terminal].filter(Boolean).join("\n\n");
	}
	if (snapshot.status !== "running") return `Workflow ${snapshot.workflowName} is ${snapshot.status}. Use /workflow resume to continue if appropriate.`;
	return buildCurrentStepProtocol(snapshot);
}

export function summarizeWorkflow(snapshot: WorkflowSnapshot): string {
	const current = snapshot.currentStep ? `${snapshot.currentStep} (${snapshot.workflow.steps[snapshot.currentStep]?.type ?? "missing"})` : "none";
	const artifacts = Object.keys(snapshot.artifacts);
	return [
		`Workflow: ${snapshot.workflowName}`,
		`Status: ${snapshot.status}`,
		`Goal: ${snapshot.goal}`,
		`Current step: ${current}`,
		`Pinned hash: ${snapshot.workflowHash}`,
		`Artifacts: ${artifacts.join(", ") || "none"}`,
		`Checkpoints: ${snapshot.history.length}`,
		snapshot.pauseReason ? `Pause reason: ${snapshot.pauseReason}` : undefined,
		snapshot.finishReason ? `Finish reason: ${snapshot.finishReason}` : undefined,
	].filter(Boolean).join("\n");
}
