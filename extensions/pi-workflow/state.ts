import { randomUUID } from "node:crypto";
import type { WorkflowCheckpointRecord, WorkflowDefinition, WorkflowEvent, WorkflowPersistedEntry, WorkflowSnapshot, WorkflowSource, WorkflowStatus } from "./types.ts";

export const WORKFLOW_ENTRY_TYPE = "pi-workflow";

export interface CheckpointParams {
	step?: string;
	outcome: string;
	summary?: string;
	evidence?: string;
	artifacts?: Array<{ name: string; content: string }>;
}

export interface StateTransitionResult {
	snapshot: WorkflowSnapshot;
	events: WorkflowEvent[];
	message: string;
	finished: boolean;
}

function nowIso(now: Date = new Date()): string {
	return now.toISOString();
}

function cloneSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
	return JSON.parse(JSON.stringify(snapshot)) as WorkflowSnapshot;
}

export function isActiveStatus(status: WorkflowStatus): boolean {
	return status === "running" || status === "paused" || status === "interrupted";
}

export function createRunSnapshot(args: {
	workflow: WorkflowDefinition;
	workflowPath: string;
	workflowSource: WorkflowSource;
	workflowHash: string;
	goal: string;
	runId?: string;
	now?: Date;
}): WorkflowSnapshot {
	const timestamp = nowIso(args.now);
	return {
		schemaVersion: 1,
		runId: args.runId ?? randomUUID(),
		workflowName: args.workflow.name,
		workflowPath: args.workflowPath,
		workflowSource: args.workflowSource,
		workflowHash: args.workflowHash,
		workflow: args.workflow,
		goal: args.goal,
		status: "running",
		currentStep: args.workflow.start,
		artifacts: {},
		history: [],
		startedAt: timestamp,
		updatedAt: timestamp,
	};
}

export function startEvent(snapshot: WorkflowSnapshot): WorkflowEvent {
	return { kind: "started", runId: snapshot.runId, timestamp: snapshot.startedAt, workflowName: snapshot.workflowName, goal: snapshot.goal };
}

export function pauseRun(snapshot: WorkflowSnapshot, reason = "paused by user", now = new Date()): StateTransitionResult {
	if (snapshot.status !== "running") throw new Error(`Cannot pause workflow while status is ${snapshot.status}.`);
	const next = cloneSnapshot(snapshot);
	next.status = "paused";
	next.pauseReason = reason;
	next.updatedAt = nowIso(now);
	const event: WorkflowEvent = { kind: "paused", runId: next.runId, timestamp: next.updatedAt, reason };
	return { snapshot: next, events: [event], message: `Workflow paused: ${reason}`, finished: false };
}

export function resumeRun(snapshot: WorkflowSnapshot, now = new Date()): StateTransitionResult {
	if (snapshot.status !== "paused" && snapshot.status !== "interrupted") throw new Error(`Cannot resume workflow while status is ${snapshot.status}.`);
	const next = cloneSnapshot(snapshot);
	next.status = "running";
	next.pauseReason = undefined;
	next.updatedAt = nowIso(now);
	const event: WorkflowEvent = { kind: "resumed", runId: next.runId, timestamp: next.updatedAt };
	return { snapshot: next, events: [event], message: "Workflow resumed.", finished: false };
}

export function restartRun(snapshot: WorkflowSnapshot, now = new Date()): StateTransitionResult {
	const next = cloneSnapshot(snapshot);
	next.status = "running";
	next.currentStep = next.workflow.start;
	next.artifacts = {};
	next.history = [];
	next.pauseReason = undefined;
	next.finishReason = undefined;
	next.updatedAt = nowIso(now);
	const event: WorkflowEvent = { kind: "restarted", runId: next.runId, timestamp: next.updatedAt };
	return { snapshot: next, events: [event], message: "Workflow restarted from the first step using the pinned workflow snapshot.", finished: false };
}

export function cancelRun(snapshot: WorkflowSnapshot, reason = "canceled by user", now = new Date()): StateTransitionResult {
	if (!isActiveStatus(snapshot.status)) throw new Error(`Cannot cancel workflow while status is ${snapshot.status}.`);
	const next = cloneSnapshot(snapshot);
	next.status = "canceled";
	next.finishReason = reason;
	next.updatedAt = nowIso(now);
	const event: WorkflowEvent = { kind: "canceled", runId: next.runId, timestamp: next.updatedAt, reason };
	return { snapshot: next, events: [event], message: `Workflow canceled: ${reason}`, finished: true };
}

export function applyCheckpoint(snapshot: WorkflowSnapshot, params: CheckpointParams, now = new Date()): StateTransitionResult {
	if (snapshot.status !== "running") throw new Error(`workflow_checkpoint is only available while a workflow is running. Current status: ${snapshot.status}.`);
	const stepId = snapshot.currentStep;
	if (!stepId) throw new Error("No current workflow step is set.");
	if (params.step && params.step !== stepId) {
		throw new Error(`Stale workflow_checkpoint for step ${params.step}; current step is ${stepId}. Re-read the workflow instructions and checkpoint the current step only.`);
	}
	const step = snapshot.workflow.steps[stepId];
	if (!step) throw new Error(`Current step no longer exists in pinned workflow snapshot: ${stepId}.`);
	if (step.type === "end") throw new Error("End steps do not accept checkpoints.");
	if (!params.outcome || !(params.outcome in (step.transitions ?? {}))) {
		const allowed = Object.keys(step.transitions ?? {}).join(", ") || "none";
		throw new Error(`Invalid outcome for step ${stepId}: ${params.outcome || "(missing)"}. Allowed outcomes: ${allowed}.`);
	}

	const transition = step.transitions![params.outcome]!;
	const submittedArtifacts = params.artifacts ?? [];
	const byName = new Map<string, string>();
	for (const artifact of submittedArtifacts) {
		if (!artifact || typeof artifact.name !== "string" || typeof artifact.content !== "string") throw new Error("Each artifact must include string name and string content.");
		if (!(artifact.name in snapshot.workflow.artifacts)) throw new Error(`Artifact is not declared by this workflow: ${artifact.name}.`);
		byName.set(artifact.name, artifact.content);
	}
	const missing = transition.requireOutputs ? (step.outputs ?? []).filter((name) => !byName.has(name)) : [];
	if (missing.length > 0) {
		throw new Error(`Step ${stepId} requires artifact output(s): ${missing.join(", ")}. Include them in workflow_checkpoint.artifacts as text content.`);
	}

	const timestamp = nowIso(now);
	const next = cloneSnapshot(snapshot);
	for (const [name, content] of byName) next.artifacts[name] = content;
	const target = transition.target;
	const targetStep = next.workflow.steps[target];
	if (!targetStep) throw new Error(`Transition target no longer exists in pinned workflow snapshot: ${target}.`);
	const record: WorkflowCheckpointRecord = {
		step: stepId,
		outcome: params.outcome,
		summary: params.summary,
		evidence: params.evidence,
		artifacts: [...byName.keys()],
		nextStep: target,
		timestamp,
	};
	next.history.push(record);
	next.updatedAt = timestamp;

	const events: WorkflowEvent[] = [{ kind: "checkpoint", runId: next.runId, timestamp, record }];
	let message: string;
	let finished = false;
	if (targetStep.type === "end") {
		next.currentStep = target;
		const terminalStatus = targetStep.status ?? "completed";
		next.status = terminalStatus;
		next.finishReason = `Reached ${terminalStatus} end step ${target} via outcome ${params.outcome}.`;
		if (terminalStatus === "canceled") events.push({ kind: "canceled", runId: next.runId, timestamp, reason: next.finishReason });
		else if (terminalStatus === "failed") events.push({ kind: "failed", runId: next.runId, timestamp, reason: next.finishReason });
		else events.push({ kind: "completed", runId: next.runId, timestamp, reason: next.finishReason });
		message = `Workflow ${terminalStatus} at end step ${target}.`;
		finished = true;
	} else {
		next.currentStep = target;
		message = `Checkpoint accepted. Continue with workflow step ${target}.`;
	}

	return { snapshot: next, events, message, finished };
}

function isPersistedEntry(value: unknown): value is WorkflowPersistedEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return (entry.kind === "snapshot" && !!entry.snapshot) || (entry.kind === "event" && !!entry.event);
}

export function persistedEntriesFromBranch(branchEntries: Array<any>): WorkflowPersistedEntry[] {
	const out: WorkflowPersistedEntry[] = [];
	for (const entry of branchEntries) {
		if (entry?.type !== "custom" || entry.customType !== WORKFLOW_ENTRY_TYPE) continue;
		if (isPersistedEntry(entry.data)) out.push(entry.data);
	}
	return out;
}

export function restoreSnapshotFromBranch(branchEntries: Array<any>): WorkflowSnapshot | undefined {
	let latest: WorkflowSnapshot | undefined;
	for (const persisted of persistedEntriesFromBranch(branchEntries)) {
		if (persisted.kind === "snapshot") latest = persisted.snapshot;
	}
	if (!latest) return undefined;
	const restored = cloneSnapshot(latest);
	if (restored.status === "running") {
		restored.status = "interrupted";
		restored.pauseReason = "Session was reloaded or branch was restored while the workflow was running. Use /workflow resume to continue.";
	}
	return restored;
}

export function persistedEvent(event: WorkflowEvent): WorkflowPersistedEntry {
	return { kind: "event", event };
}

export function persistedSnapshot(snapshot: WorkflowSnapshot): WorkflowPersistedEntry {
	return { kind: "snapshot", snapshot };
}
