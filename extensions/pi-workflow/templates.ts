import type { Diagnostic, WorkflowDefinition, WorkflowStep } from "./types.ts";

const TEMPLATE_RE = /{{\s*([^{}]+?)\s*}}/g;
const RAW_BRACE_RE = /{{|}}/;

export interface TemplateRef {
	raw: string;
	expression: string;
	kind: "input.goal" | "artifact" | "invalid";
	artifactName?: string;
}

export function extractTemplateRefs(template: string): TemplateRef[] {
	const refs: TemplateRef[] = [];
	for (const match of template.matchAll(TEMPLATE_RE)) {
		const expression = match[1]?.trim() ?? "";
		if (expression === "input.goal") {
			refs.push({ raw: match[0], expression, kind: "input.goal" });
		} else if (expression.startsWith("artifacts.")) {
			refs.push({ raw: match[0], expression, kind: "artifact", artifactName: expression.slice("artifacts.".length) });
		} else {
			refs.push({ raw: match[0], expression, kind: "invalid" });
		}
	}
	return refs;
}

export function referencedArtifacts(template: string): string[] {
	return [...new Set(extractTemplateRefs(template)
		.filter((ref): ref is TemplateRef & { artifactName: string } => ref.kind === "artifact" && !!ref.artifactName)
		.map((ref) => ref.artifactName))];
}

export function renderTemplate(template: string, values: { goal: string; artifacts: Record<string, string> }): string {
	return template.replace(TEMPLATE_RE, (_raw, expression: string) => {
		const key = expression.trim();
		if (key === "input.goal") return values.goal;
		if (key.startsWith("artifacts.")) {
			const name = key.slice("artifacts.".length);
			return values.artifacts[name] ?? `[artifact ${name} is not available yet]`;
		}
		return `[invalid template ${key}]`;
	});
}

function validateTemplate(template: string, path: string, artifactNames: Set<string>): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const consumed = template.replace(TEMPLATE_RE, "");
	if (RAW_BRACE_RE.test(consumed)) {
		diagnostics.push({
			severity: "error",
			path,
			message: "Malformed template braces.",
			suggestion: "Templates must use complete {{input.goal}} or {{artifacts.name}} expressions only.",
		});
	}

	for (const ref of extractTemplateRefs(template)) {
		if (ref.kind === "invalid") {
			diagnostics.push({
				severity: "error",
				path,
				message: `Unsafe template expression: {{${ref.expression}}}.`,
				suggestion: "Only {{input.goal}} and {{artifacts.<declaredName>}} are allowed. No filters, functions, environment access, or code execution are supported.",
			});
			continue;
		}
		if (ref.kind === "artifact") {
			if (!ref.artifactName || !artifactNames.has(ref.artifactName)) {
				diagnostics.push({
					severity: "error",
					path,
					message: `Template references undeclared artifact: ${ref.artifactName || "(empty)"}.`,
					suggestion: "Declare the artifact under artifacts: with type: text, or remove the template reference.",
				});
			}
		}
	}
	return diagnostics;
}

function templatesForStep(step: WorkflowStep): Array<{ path: string; value: string }> {
	const templates: Array<{ path: string; value: string }> = [];
	if (typeof step.instructions === "string") templates.push({ path: "instructions", value: step.instructions });
	if (step.delegate) {
		if (typeof step.delegate.guidance === "string") templates.push({ path: "delegate.guidance", value: step.delegate.guidance });
		if (typeof step.delegate.task === "string") templates.push({ path: "delegate.task", value: step.delegate.task });
		for (let i = 0; i < (step.delegate.tasks?.length ?? 0); i++) {
			const task = step.delegate.tasks![i];
			templates.push({ path: `delegate.tasks[${i}].task`, value: task.task });
			if (task.responsibility) templates.push({ path: `delegate.tasks[${i}].responsibility`, value: task.responsibility });
		}
	}
	return templates;
}

export function validateWorkflowTemplates(workflow: WorkflowDefinition): Diagnostic[] {
	const artifactNames = new Set(Object.keys(workflow.artifacts));
	const diagnostics: Diagnostic[] = [];
	for (const [stepId, step] of Object.entries(workflow.steps)) {
		for (const template of templatesForStep(step)) {
			diagnostics.push(...validateTemplate(template.value, `steps.${stepId}.${template.path}`, artifactNames));
		}
	}
	return diagnostics;
}

export function referencedArtifactsForStep(step: WorkflowStep): string[] {
	const refs = new Set<string>();
	for (const template of templatesForStep(step)) {
		for (const name of referencedArtifacts(template.value)) refs.add(name);
	}
	return [...refs];
}
