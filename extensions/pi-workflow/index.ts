import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildContinuationInstructions, buildCurrentStepProtocol, summarizeWorkflow } from "./instructions.ts";
import { formatDiagnostics, loadWorkflowCatalog, parseWorkflowFile } from "./parser.ts";
import { applyCheckpoint, cancelRun, createRunSnapshot, isActiveStatus, pauseRun, persistedEvent, persistedSnapshot, restartRun, restoreSnapshotFromBranch, resumeRun, startEvent, WORKFLOW_ENTRY_TYPE, type CheckpointParams } from "./state.ts";
import type { ValidationContext, WorkflowCatalogEntry, WorkflowEvent, WorkflowSnapshot } from "./types.ts";

const CHECKPOINT_TOOL = "workflow_checkpoint";

interface SubagentMetadata {
	name: string;
	description?: string;
	enabled?: boolean;
	userEnabled?: boolean;
	temporarilyRestricted?: boolean;
}

type SubagentsBridge = {
	listAgents?: () => SubagentMetadata[];
	setTemporaryAgentRestriction?: (owner: string, allowedAgents: readonly string[]) => boolean;
	clearTemporaryAgentRestriction?: (owner: string) => boolean;
};

interface SubagentMetadataResult {
	bridge?: SubagentsBridge;
	metadata?: SubagentMetadata[];
	error?: string;
}

function readSubagentMetadata(): SubagentMetadataResult {
	const bridge = (globalThis as any).__pi_subagents as SubagentsBridge | undefined;
	if (!bridge) return { error: "pi-subagents registry bridge is unavailable." };
	if (!bridge.listAgents) return { bridge, error: "pi-subagents registry bridge does not provide listAgents()." };
	try {
		const metadata = bridge.listAgents();
		if (!Array.isArray(metadata)) return { bridge, error: "pi-subagents listAgents() returned invalid metadata." };
		return { bridge, metadata };
	} catch (error) {
		return { bridge, error: `pi-subagents listAgents() failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export function getSubagentNames(): string[] | undefined {
	const result = readSubagentMetadata();
	if (!result.metadata) return result.bridge ? [] : undefined;
	return result.metadata
		.filter((agent) => agent.enabled !== false)
		.map((agent) => agent.name)
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b));
}

interface WorkflowAgentPromptContext {
	enabledAgents: string[];
	knownAgents: string[];
	error?: string;
}

function workflowAgentPromptContext(): WorkflowAgentPromptContext {
	const result = readSubagentMetadata();
	if (result.error || !result.metadata) {
		return { enabledAgents: [], knownAgents: [], error: result.error ?? "pi-subagents registry metadata is unavailable." };
	}
	const knownAgents = result.metadata.map((agent) => agent.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
	const enabledAgents = result.metadata
		.filter((agent) => agent.enabled !== false)
		.map((agent) => agent.name)
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b));
	return { enabledAgents, knownAgents };
}

function validationContext(): ValidationContext {
	const result = readSubagentMetadata();
	if (result.error || !result.metadata) return { agentRegistryError: result.error ?? "pi-subagents registry metadata is unavailable." };
	if (!result.bridge?.setTemporaryAgentRestriction || !result.bridge.clearTemporaryAgentRestriction) {
		return { agentRegistryError: "pi-subagents registry bridge does not support temporary workflow restrictions." };
	}
	return {
		availableAgents: result.metadata.map((agent) => agent.name).filter(Boolean).sort((a, b) => a.localeCompare(b)),
		disabledAgents: result.metadata
			.filter((agent) => (agent.userEnabled ?? agent.enabled) === false)
			.map((agent) => agent.name),
	};
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

const WORKFLOW_RESTRICTION_OWNER = "pi-workflow";

export interface WorkflowAgentAvailabilityUpdate {
	ok: boolean;
	required: boolean;
	error?: string;
}

export interface WorkflowAgentAvailabilityController {
	setSnapshot(snapshot: WorkflowSnapshot | undefined): WorkflowAgentAvailabilityUpdate;
	restore(): WorkflowAgentAvailabilityUpdate;
}

function delegateAgentNames(snapshot: WorkflowSnapshot | undefined): string[] | undefined {
	if (!snapshot || snapshot.status !== "running" || !snapshot.currentStep) return undefined;
	const step = snapshot.workflow.steps[snapshot.currentStep];
	if (step?.type !== "delegate" || !step.delegate) return undefined;
	const names = step.delegate.agent
		? [step.delegate.agent]
		: step.delegate.tasks?.map((task) => task.agent) ?? step.delegate.agents ?? [];
	return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function executableDelegateAgentNames(snapshot: WorkflowSnapshot, enabledAgents: readonly string[]): string[] {
	if (!snapshot.currentStep) return [];
	const step = snapshot.workflow.steps[snapshot.currentStep];
	if (step?.type !== "delegate" || !step.delegate) return [];
	const enabled = new Set(enabledAgents);
	if (step.delegate.agent) return enabled.has(step.delegate.agent) ? [step.delegate.agent] : [];
	if (step.delegate.tasks) {
		if (!step.delegate.tasks.every((task) => enabled.has(task.agent))) return [];
		return [...new Set(step.delegate.tasks.map((task) => task.agent))].sort((a, b) => a.localeCompare(b));
	}
	return [...new Set((step.delegate.agents ?? []).filter((name) => enabled.has(name)))].sort((a, b) => a.localeCompare(b));
}

export function createWorkflowAgentAvailabilityController(): WorkflowAgentAvailabilityController {
	// Start pending so a hot-reloaded workflow extension clears a restriction left
	// by its previous controller. Failed clears retain this bit and are retried.
	let restrictionMayExist = true;

	const reconcile = (allowedAgents: readonly string[] | undefined): WorkflowAgentAvailabilityUpdate => {
		const bridge = (globalThis as any).__pi_subagents as SubagentsBridge | undefined;
		if (allowedAgents) {
			if (!bridge?.setTemporaryAgentRestriction) {
				return { ok: false, required: true, error: "pi-subagents cannot enforce temporary workflow restrictions." };
			}
			// A bridge may apply its state before returning false/throwing (for
			// example, while notifying listeners). Keep clear bookkeeping pending
			// before the call so rollback and later turns can always retry cleanup.
			restrictionMayExist = true;
			try {
				if (bridge.setTemporaryAgentRestriction(WORKFLOW_RESTRICTION_OWNER, allowedAgents) !== true) {
					return { ok: false, required: true, error: "pi-subagents rejected the temporary workflow restriction." };
				}
				return { ok: true, required: true };
			} catch (error) {
				return { ok: false, required: true, error: `pi-subagents restriction failed: ${error instanceof Error ? error.message : String(error)}` };
			}
		}

		if (!restrictionMayExist) return { ok: true, required: false };
		if (!bridge?.clearTemporaryAgentRestriction) {
			return { ok: false, required: false, error: "pi-subagents cannot clear the temporary workflow restriction yet." };
		}
		try {
			if (bridge.clearTemporaryAgentRestriction(WORKFLOW_RESTRICTION_OWNER) !== true) {
				return { ok: false, required: false, error: "pi-subagents did not clear the temporary workflow restriction yet." };
			}
			restrictionMayExist = false;
			return { ok: true, required: false };
		} catch (error) {
			return { ok: false, required: false, error: `pi-subagents restriction restore failed: ${error instanceof Error ? error.message : String(error)}` };
		}
	};

	return {
		setSnapshot(snapshot) {
			return reconcile(delegateAgentNames(snapshot));
		},
		restore() {
			return reconcile(undefined);
		},
	};
}

export default function piWorkflowExtension(pi: ExtensionAPI): void {
	let activeSnapshot: WorkflowSnapshot | undefined;
	let agentExecutionReady = false;
	let executableAgents = new Set<string>();
	const workflowAgentAvailability = createWorkflowAgentAvailabilityController();
	const workflowRuntimeBridge = {
		isRunning: () => activeSnapshot?.status === "running",
		canRunAgent: (name: string): { allowed: boolean; reason?: string } => {
			if (!activeSnapshot || activeSnapshot.status !== "running") return { allowed: true };
			const step = activeSnapshot.currentStep ? activeSnapshot.workflow.steps[activeSnapshot.currentStep] : undefined;
			if (step?.type !== "delegate") {
				return { allowed: false, reason: "The current workflow step does not permit subagent execution." };
			}
			if (!agentExecutionReady) {
				return { allowed: false, reason: "The active workflow could not verify its delegate restriction." };
			}
			if (!executableAgents.has(name)) {
				return { allowed: false, reason: `Agent ${name} is unavailable to the active workflow step.` };
			}
			return { allowed: true };
		},
	};
	(globalThis as any).__pi_workflow = workflowRuntimeBridge;

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
		// Keep workflow state in the compact footer status. Clearing the legacy
		// widget also removes it immediately when this update is hot-reloaded.
		ctx.ui.setWidget("pi-workflow", undefined);
	}

	function persist(events: WorkflowEvent[], snapshot: WorkflowSnapshot): void {
		for (const event of events) pi.appendEntry(WORKFLOW_ENTRY_TYPE, persistedEvent(event));
		pi.appendEntry(WORKFLOW_ENTRY_TYPE, persistedSnapshot(snapshot));
	}

	function setSnapshot(ctx: ExtensionContext, snapshot: WorkflowSnapshot, events?: WorkflowEvent[]): void {
		const previousSnapshot = activeSnapshot;
		const availability = workflowAgentAvailability.setSnapshot(snapshot);
		if (availability.required && !availability.ok) {
			const rollback = workflowAgentAvailability.setSnapshot(previousSnapshot);
			agentExecutionReady = false;
			executableAgents = new Set();
			const rollbackMessage = rollback.ok ? "" : ` Restoration also needs retrying: ${rollback.error}`;
			throw new Error(`Cannot enter workflow delegate step because its runtime restriction was not enforced: ${availability.error}${rollbackMessage}`);
		}
		activeSnapshot = snapshot;
		agentExecutionReady = false;
		executableAgents = new Set();
		setCheckpointToolActive(snapshot.status === "running");
		if (events) persist(events, snapshot);
		updateUi(ctx);
		if (!availability.ok) {
			ctx.ui.notify(`Workflow state changed, but temporary agent availability restoration will be retried. ${availability.error}`, "warning");
		}
	}

	function restore(ctx: ExtensionContext): void {
		workflowAgentAvailability.restore();
		activeSnapshot = restoreSnapshotFromBranch(ctx.sessionManager.getBranch() as any[]);
		const availability = workflowAgentAvailability.setSnapshot(activeSnapshot);
		agentExecutionReady = false;
		executableAgents = new Set();
		setCheckpointToolActive(activeSnapshot?.status === "running");
		updateUi(ctx);
		if (!availability.ok && ctx.hasUI) {
			ctx.ui.notify(`Temporary agent availability restoration will be retried. ${availability.error}`, "warning");
		}
		if (activeSnapshot?.status === "interrupted" && ctx.hasUI) {
			ctx.ui.notify(`Workflow ${activeSnapshot.workflowName} was interrupted during session restore. Use /workflow resume to continue.`, "warning");
		}
	}

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", async () => {
		activeSnapshot = undefined;
		agentExecutionReady = false;
		executableAgents = new Set();
		workflowAgentAvailability.restore();
		setCheckpointToolActive(false);
	});

	pi.on("before_agent_start", async (_event, _ctx) => {
		const availability = workflowAgentAvailability.setSnapshot(activeSnapshot);
		agentExecutionReady = false;
		executableAgents = new Set();
		if (!activeSnapshot || activeSnapshot.status !== "running") return;
		if (availability.required && !availability.ok) {
			setCheckpointToolActive(false);
			return {
				systemPrompt: `${_event.systemPrompt}\n\nACTIVE PI-WORKFLOW BLOCKED\n\nDo not continue the workflow or call subagents. Report this runtime enforcement failure to the user: ${availability.error}`,
			};
		}
		const promptContext = workflowAgentPromptContext();
		if (promptContext.error) {
			agentExecutionReady = false;
			setCheckpointToolActive(false);
			return {
				systemPrompt: `${_event.systemPrompt}\n\nACTIVE PI-WORKFLOW BLOCKED\n\nDo not continue the workflow or call subagents. Live agent availability could not be read safely: ${promptContext.error}`,
			};
		}
		agentExecutionReady = true;
		executableAgents = new Set(executableDelegateAgentNames(activeSnapshot, promptContext.enabledAgents));
		setCheckpointToolActive(true);
		return { systemPrompt: `${_event.systemPrompt}\n\n${buildCurrentStepProtocol(activeSnapshot, promptContext.enabledAgents, promptContext.knownAgents)}` };
	});

	pi.registerTool({
		name: CHECKPOINT_TOOL,
		label: "Workflow Checkpoint",
		description: "Internal pi-workflow tool. Checkpoint the current workflow step with an allowed outcome and required text artifacts.",
		promptSnippet: "Checkpoint the current pi-workflow step and receive the next-step continuation",
		promptGuidelines: [
			"Use workflow_checkpoint only when an active pi-workflow run instructs you to checkpoint the current step.",
			"workflow_checkpoint must include an allowed outcome for the current step and all required text artifact outputs.",
			"Never emit workflow_checkpoint in parallel with subagent or other tool calls; checkpoint only after every current-step tool result is available.",
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
			const promptContext = workflowAgentPromptContext();
			agentExecutionReady = !promptContext.error;
			executableAgents = promptContext.error
				? new Set()
				: new Set(executableDelegateAgentNames(result.snapshot, promptContext.enabledAgents));
			const continuation = promptContext.error
				? `Agent-aware continuation instructions are withheld until live availability can be read safely. ${promptContext.error}`
				: buildContinuationInstructions(result.snapshot, promptContext.enabledAgents, promptContext.knownAgents);
			if (result.finished) {
				setCheckpointToolActive(false);
				return {
					content: [{ type: "text", text: `${result.message}\n\n${continuation}` }],
					details: { snapshot: result.snapshot },
				};
			}
			return {
				content: [{ type: "text", text: `${result.message}\n\n${continuation}` }],
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
					const found = findWorkflow(ctx, name);
					if (!found.entry) throw new Error(`Workflow not found or invalid: ${name}\n${found.diagnostics}`);
					const entry = found.entry;
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
