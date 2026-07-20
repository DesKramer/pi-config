export type WorkflowSource = "user" | "project" | "path";
export type WorkflowStatus = "running" | "paused" | "interrupted" | "completed" | "canceled" | "failed";
export type StepType = "main" | "delegate" | "end";

export interface Diagnostic {
	severity: "error" | "warning";
	path: string;
	message: string;
	suggestion?: string;
}

export interface ArtifactDeclaration {
	type: "text";
	description?: string;
}

export interface FixedDelegateTask {
	agent: string;
	task: string;
	responsibility?: string;
}

export interface DelegateSpec {
	/** Fixed single-agent shorthand. Exactly one fixed/dynamic form is allowed. */
	agent?: string;
	/** Fixed task list. The main agent should dispatch every entry. */
	tasks?: FixedDelegateTask[];
	/** Dynamic delegate allow-list. The main agent chooses concrete calls. */
	agents?: string[];
	/** Prompt-only dynamic cardinality constraints. */
	minCalls?: number;
	maxCalls?: number;
	parallel?: boolean;
	/** Rendered into the subagent task guidance. */
	guidance?: string;
	/** Optional task template for single/dynamic calls. */
	task?: string;
}

export interface WorkflowTransition {
	target: string;
	/** Defaults to true. Set false for abort/clarification paths that cannot produce normal outputs. */
	requireOutputs: boolean;
}

export interface WorkflowStep {
	type: StepType;
	instructions?: string;
	delegate?: DelegateSpec;
	outputs?: string[];
	transitions?: Record<string, WorkflowTransition>;
	/** Terminal status for end steps. Defaults to completed. */
	status?: "completed" | "canceled" | "failed";
}

export interface WorkflowDefinition {
	version: 1;
	name: string;
	description: string;
	artifacts: Record<string, ArtifactDeclaration>;
	start: string;
	steps: Record<string, WorkflowStep>;
}

export interface ParsedWorkflow {
	workflow?: WorkflowDefinition;
	diagnostics: Diagnostic[];
	path?: string;
	source?: WorkflowSource;
	hash?: string;
}

export interface WorkflowCatalogEntry {
	workflow: WorkflowDefinition;
	path: string;
	source: WorkflowSource;
	hash: string;
	diagnostics: Diagnostic[];
}

export interface WorkflowCheckpointRecord {
	step: string;
	outcome: string;
	summary?: string;
	evidence?: string;
	artifacts: string[];
	nextStep?: string;
	timestamp: string;
}

export interface WorkflowSnapshot {
	schemaVersion: 1;
	runId: string;
	workflowName: string;
	workflowPath: string;
	workflowSource: WorkflowSource;
	workflowHash: string;
	workflow: WorkflowDefinition;
	goal: string;
	status: WorkflowStatus;
	currentStep?: string;
	artifacts: Record<string, string>;
	history: WorkflowCheckpointRecord[];
	startedAt: string;
	updatedAt: string;
	pauseReason?: string;
	finishReason?: string;
}

export type WorkflowEvent =
	| { kind: "started"; runId: string; timestamp: string; workflowName: string; goal: string }
	| { kind: "checkpoint"; runId: string; timestamp: string; record: WorkflowCheckpointRecord }
	| { kind: "paused"; runId: string; timestamp: string; reason?: string }
	| { kind: "resumed"; runId: string; timestamp: string }
	| { kind: "restarted"; runId: string; timestamp: string }
	| { kind: "completed"; runId: string; timestamp: string; reason?: string }
	| { kind: "canceled"; runId: string; timestamp: string; reason?: string }
	| { kind: "failed"; runId: string; timestamp: string; reason: string };

export type WorkflowPersistedEntry =
	| { kind: "event"; event: WorkflowEvent }
	| { kind: "snapshot"; snapshot: WorkflowSnapshot };

export interface ValidationContext {
	availableAgents?: string[];
}
