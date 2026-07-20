import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildContinuationInstructions, buildCurrentStepProtocol, summarizeWorkflow } from "./instructions.ts";
import { formatDiagnostics, loadWorkflowCatalog, parseWorkflowFile } from "./parser.ts";
import { applyCheckpoint, cancelRun, createRunSnapshot, isActiveStatus, pauseRun, persistedEvent, persistedSnapshot, restartRun, restoreSnapshotFromBranch, resumeRun, startEvent, WORKFLOW_ENTRY_TYPE, type CheckpointParams } from "./state.ts";
import type { ValidationContext, WorkflowCatalogEntry, WorkflowEvent, WorkflowSnapshot } from "./types.ts";

const CHECKPOINT_TOOL = "workflow_checkpoint";

type SubagentsBridge = {
	listAgents?: () => Array<{ name: string; description?: string }>;
};

function getSubagentNames(): string[] | undefined {
	const bridge = (globalThis as any).__pi_subagents as SubagentsBridge | undefined;
	if (!bridge?.listAgents) return undefined;
	try {
		return bridge.listAgents().map((agent) => agent.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
	} catch {
		return undefined;
	}
}

function validationContext(): ValidationContext {
	const availableAgents = getSubagentNames();
	return availableAgents ? { availableAgents } : {};
}

function isTrusted(ctx: ExtensionContext): boolean {
	try {
		return !!ctx.isProjectTrusted?.();
	} catch {
		return false;
	}
}

function splitArgs(input: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaping = false;
	for (const ch of input.trim()) {
		if (escaping) {
			current += ch;
			escaping = false;
			continue;
		}
		if (ch === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) out.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current) out.push(current);
	return out;
}

function catalogFor(ctx: ExtensionContext) {
	return loadWorkflowCatalog({ cwd: ctx.cwd, projectTrusted: isTrusted(ctx), validation: validationContext(), configDirName: CONFIG_DIR_NAME });
}

function findWorkflow(ctx: ExtensionContext, name: string): { entry?: WorkflowCatalogEntry; diagnostics: string } {
	const catalog = catalogFor(ctx);
	return { entry: catalog.entries.find((item) => item.workflow.name === name), diagnostics: formatDiagnostics(catalog.diagnostics) };
}

function commandUsage(): string {
	return [
		"Usage:",
		"/workflow list",
		"/workflow show <name|path>",
		"/workflow validate [name|path]",
		"/workflow run <name> <goal>",
		"/workflow status",
		"/workflow pause",
		"/workflow resume",
		"/workflow restart",
		"/workflow cancel",
	].join("\n");
}

export default function piWorkflowExtension(pi: ExtensionAPI): void {
	let activeSnapshot: WorkflowSnapshot | undefined;

	function setCheckpointToolActive(active: boolean): void {
		try {
			const current = pi.getActiveTools();
			const hasTool = current.includes(CHECKPOINT_TOOL);
			if (active && !hasTool) pi.setActiveTools([...current, CHECKPOINT_TOOL]);
			if (!active && hasTool) pi.setActiveTools(current.filter((name) => name !== CHECKPOINT_TOOL));
		} catch {
			// Tool activation is session-scoped. If called before a runtime exists, the
			// next session_start/before_agent_start hook will reconcile it.
		}
	}

	function updateUi(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!activeSnapshot || !isActiveStatus(activeSnapshot.status)) {
			ctx.ui.setStatus("pi-workflow", undefined);
			ctx.ui.setWidget("pi-workflow", undefined);
			return;
		}
		const step = activeSnapshot.currentStep ?? "?";
		const status = activeSnapshot.status === "running" ? "▶" : "⏸";
		ctx.ui.setStatus("pi-workflow", ctx.ui.theme.fg(activeSnapshot.status === "running" ? "accent" : "warning", `${status} workflow:${step}`));
		ctx.ui.setWidget("pi-workflow", [
			`Workflow: ${activeSnapshot.workflowName}`,
			`Status: ${activeSnapshot.status}`,
			`Step: ${step}`,
			`Goal: ${activeSnapshot.goal}`,
		]);
	}

	function persist(events: WorkflowEvent[], snapshot: WorkflowSnapshot): void {
		for (const event of events) pi.appendEntry(WORKFLOW_ENTRY_TYPE, persistedEvent(event));
		pi.appendEntry(WORKFLOW_ENTRY_TYPE, persistedSnapshot(snapshot));
	}

	function setSnapshot(ctx: ExtensionContext, snapshot: WorkflowSnapshot, events?: WorkflowEvent[]): void {
		activeSnapshot = snapshot;
		setCheckpointToolActive(snapshot.status === "running");
		if (events) persist(events, snapshot);
		updateUi(ctx);
	}

	function restore(ctx: ExtensionContext): void {
		activeSnapshot = restoreSnapshotFromBranch(ctx.sessionManager.getBranch() as any[]);
		setCheckpointToolActive(activeSnapshot?.status === "running");
		updateUi(ctx);
		if (activeSnapshot?.status === "interrupted" && ctx.hasUI) {
			ctx.ui.notify(`Workflow ${activeSnapshot.workflowName} was interrupted during session restore. Use /workflow resume to continue.`, "warning");
		}
	}

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", async () => setCheckpointToolActive(false));

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!activeSnapshot || activeSnapshot.status !== "running") return;
		setCheckpointToolActive(true);
		return { systemPrompt: `${_event.systemPrompt}\n\n${buildCurrentStepProtocol(activeSnapshot)}` };
	});

	pi.registerTool({
		name: CHECKPOINT_TOOL,
		label: "Workflow Checkpoint",
		description: "Internal pi-workflow tool. Checkpoint the current workflow step with an allowed outcome and required text artifacts.",
		promptSnippet: "Checkpoint the current pi-workflow step and receive the next-step continuation",
		promptGuidelines: [
			"Use workflow_checkpoint only when an active pi-workflow run instructs you to checkpoint the current step.",
			"workflow_checkpoint must include an allowed outcome for the current step and all required text artifact outputs.",
		],
		parameters: Type.Object({
			step: Type.Optional(Type.String({ description: "Current step id. Optional, but used for stale-checking when provided." })),
			outcome: Type.String({ description: "Symbolic outcome for the current step transition." }),
			summary: Type.Optional(Type.String({ description: "Short summary of what was completed in this step." })),
			evidence: Type.Optional(Type.String({ description: "Evidence, test results, or reasoning supporting the outcome." })),
			artifacts: Type.Optional(Type.Array(Type.Object({
				name: Type.String({ description: "Declared text artifact name." }),
				content: Type.String({ description: "Artifact text content." }),
			}, { additionalProperties: false }), { description: "Text artifacts produced by this step." })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!activeSnapshot || !isActiveStatus(activeSnapshot.status)) throw new Error("No active pi-workflow run. Start one with /workflow run <name> <goal>.");
			const result = applyCheckpoint(activeSnapshot, params as CheckpointParams);
			setSnapshot(ctx, result.snapshot, result.events);
			if (result.finished) {
				setCheckpointToolActive(false);
				return {
					content: [{ type: "text", text: `${result.message}\n\n${buildContinuationInstructions(result.snapshot)}` }],
					details: { snapshot: result.snapshot },
				};
			}
			return {
				content: [{ type: "text", text: `${result.message}\n\n${buildContinuationInstructions(result.snapshot)}` }],
				details: { snapshot: result.snapshot },
			};
		},
	});
	setCheckpointToolActive(false);

	pi.registerCommand("workflow", {
		description: "Manage pi-workflow v1 runs",
		handler: async (args, ctx) => {
			const parts = splitArgs(args ?? "");
			const subcommand = parts.shift();
			if (!subcommand || subcommand === "help") {
				ctx.ui.notify(commandUsage(), "info");
				return;
			}

			switch (subcommand) {
				case "list": {
					const catalog = catalogFor(ctx);
					const lines = catalog.entries.map((entry) => `${entry.workflow.name} [${entry.source}] - ${entry.workflow.description}\n  ${entry.path}`);
					const header = [
						`User workflows: ${catalog.userDir}`,
						`Project workflows: ${catalog.projectDir ?? (isTrusted(ctx) ? "none found" : "skipped; project is not trusted")}`,
						"Project workflow names override user workflow names.",
					].join("\n");
					const diagnostics = catalog.diagnostics.length ? `\n\nDiagnostics:\n${formatDiagnostics(catalog.diagnostics)}` : "";
					ctx.ui.notify(`${header}\n\n${lines.join("\n") || "No workflows found."}${diagnostics}`, catalog.diagnostics.some((d) => d.severity === "error") ? "warning" : "info");
					return;
				}

				case "show": {
					const target = parts.join(" ");
					if (!target) throw new Error("/workflow show requires a workflow name or YAML path.");
					let entry: WorkflowCatalogEntry | undefined;
					let diagnostics = "";
					if (/\.ya?ml$/i.test(target)) {
						const parsed = parseWorkflowFile(target, "path", validationContext());
						diagnostics = formatDiagnostics(parsed.diagnostics);
						if (parsed.workflow && parsed.hash) entry = { workflow: parsed.workflow, path: target, source: "path", hash: parsed.hash, diagnostics: parsed.diagnostics };
					} else {
						const found = findWorkflow(ctx, target);
						entry = found.entry;
						diagnostics = found.diagnostics;
					}
					if (!entry) {
						ctx.ui.notify(`Workflow not found or invalid: ${target}\n\n${diagnostics}`, "warning");
						return;
					}
					const wf = entry.workflow;
					const stepLines = Object.entries(wf.steps).map(([id, step]) => `- ${id}: ${step.type}${step.outputs?.length ? ` outputs[${step.outputs.join(", ")}]` : ""}${step.transitions ? ` transitions{${Object.keys(step.transitions).join(", ")}}` : ""}`);
					ctx.ui.notify([
						`${wf.name} [${entry.source}]`,
						wf.description,
						`Path: ${entry.path}`,
						`Hash: ${entry.hash}`,
						`Start: ${wf.start}`,
						`Artifacts: ${Object.keys(wf.artifacts).join(", ") || "none"}`,
						"Steps:",
						...stepLines,
					].join("\n"), "info");
					return;
				}

				case "validate": {
					const target = parts.join(" ");
					if (!target) {
						const catalog = catalogFor(ctx);
						ctx.ui.notify(catalog.diagnostics.length ? formatDiagnostics(catalog.diagnostics) : `All ${catalog.entries.length} discovered workflow(s) are valid.`, catalog.diagnostics.some((d) => d.severity === "error") ? "warning" : "info");
						return;
					}
					if (/\.ya?ml$/i.test(target)) {
						const parsed = parseWorkflowFile(target, "path", validationContext());
						ctx.ui.notify(parsed.diagnostics.length ? formatDiagnostics(parsed.diagnostics) : `Valid workflow: ${parsed.workflow?.name} (${parsed.hash})`, parsed.diagnostics.some((d) => d.severity === "error") ? "warning" : "info");
						return;
					}
					const found = findWorkflow(ctx, target);
					if (!found.entry) ctx.ui.notify(`Workflow not found: ${target}\n\n${found.diagnostics}`, "warning");
					else ctx.ui.notify(found.entry.diagnostics.length ? formatDiagnostics(found.entry.diagnostics) : `Valid workflow: ${found.entry.workflow.name} (${found.entry.hash})`, "info");
					return;
				}

				case "run": {
					const name = parts.shift();
					const goal = parts.join(" ").trim();
					if (!name || !goal) throw new Error("/workflow run requires <name> <goal>.");
					if (activeSnapshot && isActiveStatus(activeSnapshot.status)) throw new Error(`A workflow is already active (${activeSnapshot.workflowName}, ${activeSnapshot.status}). Pause/cancel/complete it before starting another.`);
					const { entry, diagnostics } = findWorkflow(ctx, name);
					if (!entry) throw new Error(`Workflow not found or invalid: ${name}\n${diagnostics}`);
					const snapshot = createRunSnapshot({ workflow: entry.workflow, workflowPath: entry.path, workflowSource: entry.source, workflowHash: entry.hash, goal });
					setSnapshot(ctx, snapshot, [startEvent(snapshot)]);
					ctx.ui.notify(`Started workflow ${name}.`, "info");
					try {
						pi.sendUserMessage(`Start pi-workflow ${snapshot.workflowName} for goal: ${snapshot.goal}`);
					} catch (error) {
						ctx.ui.notify(`Workflow started, but automatic prompt delivery failed. Submit any prompt to continue.\n${error instanceof Error ? error.message : String(error)}`, "warning");
					}
					return;
				}

				case "status": {
					ctx.ui.notify(activeSnapshot ? summarizeWorkflow(activeSnapshot) : "No workflow run is active in this branch.", "info");
					return;
				}

				case "pause": {
					if (!activeSnapshot) throw new Error("No workflow run to pause.");
					const result = pauseRun(activeSnapshot);
					setSnapshot(ctx, result.snapshot, result.events);
					ctx.ui.notify(result.message, "info");
					return;
				}

				case "resume": {
					if (!activeSnapshot) throw new Error("No workflow run to resume.");
					const result = resumeRun(activeSnapshot);
					setSnapshot(ctx, result.snapshot, result.events);
					ctx.ui.notify(result.message, "info");
					try {
						pi.sendUserMessage(`Resume pi-workflow ${result.snapshot.workflowName} at step ${result.snapshot.currentStep}.`);
					} catch (error) {
						ctx.ui.notify(`Workflow resumed, but automatic prompt delivery failed. Submit any prompt to continue.\n${error instanceof Error ? error.message : String(error)}`, "warning");
					}
					return;
				}

				case "restart": {
					if (!activeSnapshot) throw new Error("No workflow run to restart.");
					const result = restartRun(activeSnapshot);
					setSnapshot(ctx, result.snapshot, result.events);
					ctx.ui.notify(result.message, "info");
					try {
						pi.sendUserMessage(`Restart pi-workflow ${result.snapshot.workflowName} for goal: ${result.snapshot.goal}`);
					} catch (error) {
						ctx.ui.notify(`Workflow restarted, but automatic prompt delivery failed. Submit any prompt to continue.\n${error instanceof Error ? error.message : String(error)}`, "warning");
					}
					return;
				}

				case "cancel": {
					if (!activeSnapshot) throw new Error("No workflow run to cancel.");
					const result = cancelRun(activeSnapshot);
					setSnapshot(ctx, result.snapshot, result.events);
					ctx.ui.notify(result.message, "info");
					return;
				}

				default:
					ctx.ui.notify(`Unknown /workflow subcommand: ${subcommand}\n\n${commandUsage()}`, "warning");
			}
		},
	});
}
