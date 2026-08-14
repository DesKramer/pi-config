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

function omitParagraphsReferencingAgents(text: string, agentNames: readonly string[]): string {
	if (agentNames.length === 0) return text.trim();
	const patterns = agentNames.map((name) => {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`, "i");
	});
	return text
		.split(/\n\s*\n/)
		.filter((paragraph) => !patterns.some((pattern) => pattern.test(paragraph)))
		.join("\n\n")
		.trim();
}

function sanitizeWorkflowText(text: string | undefined, enabledAgents?: readonly string[], knownAgents?: readonly string[]): string {
	if (!text) return "";
	if (!enabledAgents || !knownAgents) return text.trim();
	const enabled = new Set(enabledAgents);
	return omitParagraphsReferencingAgents(text, knownAgents.filter((name) => !enabled.has(name)));
}

export function referencedArtifactBlock(snapshot: WorkflowSnapshot, step: WorkflowStep): string {
	const refs = referencedArtifactsForStep(step).filter((name) => snapshot.artifacts[name] !== undefined);
	if (refs.length === 0) return "Referenced artifacts for this step: none.";
	return [
		"Referenced artifacts for this step only:",
		...refs.map((name) => `\n--- artifact:${name} ---\n${snapshot.artifacts[name]}`),
	].join("\n");
}

export function buildCurrentStepProtocol(snapshot: WorkflowSnapshot, enabledAgents?: readonly string[], knownAgents?: readonly string[]): string {
	const { id, step } = currentStep(snapshot);
	const outcomes = Object.keys(step.transitions ?? {});
	const outputs = step.outputs ?? [];
	const parts: string[] = [];

	parts.push(`ACTIVE PI-WORKFLOW RUN: ${snapshot.workflowName}`);
	parts.push("This workflow owns the session until it is paused, canceled, or completed. Keep the conversation focused on the workflow goal; defer unrelated work unless needed to finish the current step.");
	parts.push(`Run id: ${snapshot.runId}`);
	parts.push(`Pinned workflow hash: ${snapshot.workflowHash}`);
	parts.push(`Goal: ${snapshot.goal}`);
	parts.push(`Current step: ${id} (${step.type})`);

	if (step.type === "delegate" && step.delegate) {
		const enabledSet = enabledAgents ? new Set(enabledAgents) : undefined;
		const configuredNames = step.delegate.agent
			? [step.delegate.agent]
			: step.delegate.tasks?.map((fixed) => fixed.agent) ?? step.delegate.agents ?? [];
		const unavailableKnownNames = enabledSet && knownAgents
			? knownAgents.filter((name) => !enabledSet.has(name))
			: [];
		const disabledNames = enabledSet
			? [...new Set([...configuredNames.filter((name) => !enabledSet.has(name)), ...unavailableKnownNames])]
			: [];
		const fixedAgentAvailable = !step.delegate.agent || !enabledSet || enabledSet.has(step.delegate.agent);
		const allFixedTasksAvailable = !step.delegate.tasks || !enabledSet || step.delegate.tasks.every((fixed) => enabledSet.has(fixed.agent));
		const dynamicAgents = step.delegate.agents?.filter((name) => !enabledSet || enabledSet.has(name));
		const delegationBlocked = !fixedAgentAvailable
			|| !allFixedTasksAvailable
			|| (!!step.delegate.agents && dynamicAgents?.length === 0);
		const renderedInstructions = renderOptional(step.instructions, snapshot) ?? "";
		const safeInstructions = delegationBlocked
			? ""
			: omitParagraphsReferencingAgents(renderedInstructions, disabledNames);

		parts.push("Current step instructions:");
		parts.push(safeInstructions || (delegationBlocked
			? "The configured delegation plan is currently blocked. Do not attempt delegation until an eligible profile is available."
			: "Follow the structured enabled delegation plan below; free-form text that referenced unavailable profiles was omitted."));
		parts.push("Delegate guidance (only the profiles listed below are currently available to this step):");

		if (step.delegate.agent && fixedAgentAvailable) {
			parts.push(`- Call this fixed subagent exactly once: ${step.delegate.agent}`);
		}
		if (step.delegate.tasks?.length && allFixedTasksAvailable) {
			parts.push(`- Dispatch all ${step.delegate.tasks.length} fixed task(s) exactly once${step.delegate.parallel === true ? " in parallel" : step.delegate.parallel === false ? " sequentially" : ""}:`);
			for (const fixed of step.delegate.tasks) {
				const responsibility = sanitizeWorkflowText(renderOptional(fixed.responsibility, snapshot), enabledAgents, knownAgents);
				const task = sanitizeWorkflowText(renderOptional(fixed.task, snapshot) ?? fixed.task, enabledAgents, knownAgents);
				parts.push(`  - ${fixed.agent}${responsibility ? ` — responsibility: ${responsibility}` : ""}\n    Task: ${task || "Complete the configured fixed responsibility without referencing unavailable profiles."}`);
			}
		}
		if (dynamicAgents?.length) {
			parts.push(`- Allowed subagents for dynamically generated calls: ${dynamicAgents.join(", ")}`);
			if (step.delegate.minCalls !== undefined || step.delegate.maxCalls !== undefined) {
				const minimum = step.delegate.minCalls ?? 1;
				const callCount = step.delegate.maxCalls === undefined
					? `at least ${minimum}`
					: `${minimum}..${step.delegate.maxCalls}`;
				parts.push(`- Desired call count with current availability: ${callCount}. Repeated calls to one allowed profile are valid.`);
			}
			if (step.delegate.parallel !== undefined) parts.push(`- Dispatch ${step.delegate.parallel ? "in parallel where independent" : "sequentially"}.`);
		}
		if (disabledNames.length > 0) {
			parts.push("- One or more configured profiles are unavailable. Do not call or advertise them.");
		}
		if (delegationBlocked) {
			parts.push("- This step requires an unavailable fixed profile/task or has no enabled dynamic option. Report the step as blocked; do not run a partial fixed task list.");
		} else {
			const guidance = omitParagraphsReferencingAgents(renderOptional(step.delegate.guidance, snapshot) ?? "", disabledNames);
			if (guidance) parts.push(guidance);
			const task = omitParagraphsReferencingAgents(renderOptional(step.delegate.task, snapshot) ?? "", disabledNames);
			if (task) parts.push(`Subagent task template:\n${task}`);
			parts.push("Include all relevant context in every subagent task. You must summarize useful results and failures in the checkpoint.");
		}
	} else {
		parts.push("Current step instructions:");
		parts.push(sanitizeWorkflowText(renderOptional(step.instructions, snapshot), enabledAgents, knownAgents));
	}

	parts.push(referencedArtifactBlock(snapshot, step));
	parts.push("Checkpoint protocol:");
	parts.push(`- Complete only the current step, then call workflow_checkpoint in its own tool-call batch after all current-step tool results are available.`);
	parts.push(`- workflow_checkpoint.step should be \"${id}\" (or omit it).`);
	parts.push(`- Allowed outcomes: ${outcomes.join(", ") || "none"}.`);
	parts.push(`- Required text artifact outputs for this step: ${outputs.join(", ") || "none"}.`);
	parts.push("- Include summary and evidence when useful. Include artifacts as [{name, content}] text only. Do not proceed to the next workflow step until the tool returns continuation instructions.");

	return parts.filter(Boolean).join("\n\n");
}

export function buildContinuationInstructions(snapshot: WorkflowSnapshot, enabledAgents?: readonly string[], knownAgents?: readonly string[]): string {
	if (snapshot.status === "completed" || snapshot.status === "canceled" || snapshot.status === "failed") {
		const endStep = snapshot.currentStep ? snapshot.workflow.steps[snapshot.currentStep] : undefined;
		const terminal = endStep?.type === "end"
			? sanitizeWorkflowText(renderOptional(endStep.instructions, snapshot), enabledAgents, knownAgents)
			: undefined;
		return [`Workflow ${snapshot.workflowName} is ${snapshot.status}.`, terminal].filter(Boolean).join("\n\n");
	}
	if (snapshot.status !== "running") return `Workflow ${snapshot.workflowName} is ${snapshot.status}. Use /workflow resume to continue if appropriate.`;
	return buildCurrentStepProtocol(snapshot, enabledAgents, knownAgents);
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
