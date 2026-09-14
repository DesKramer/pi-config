export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ErrorCode =
	| "INVALID_EVENT" | "DUPLICATE_EVENT_CONFLICT" | "MEMORY_PENDING" | "WRITER_INVALID"
	| "MISSING_ARTIFACT" | "CONTEXT_BUDGET_EXCEEDED" | "ACTIVE_STATE_TOO_LARGE"
	| "ILLEGAL_TOOL_SEQUENCE" | "REVISION_CONFLICT" | "UNSUPPORTED_HOST_CAPABILITY"
	| "UNSUPPORTED_SCHEMA" | "STORAGE_ERROR" | "NOT_FOUND" | "INVALID_REFERENCE";
export type Failure = { ok: false; code: ErrorCode; message: string; retryable: boolean };
export type Result<T> = { ok: true; value: T } | Failure;
export type Origin = "original" | "derived_memory" | "runtime_control";
export type EventKind = "user_message" | "agent_message" | "tool_request" | "tool_result" | "operation_status" | "workspace_change";
export type OperationStatus = "running" | "completed" | "failed" | "unknown";
export interface ArtifactInput {
	content: string; // UTF-8 text, or base64 for a binary artifact.
	encoding: "utf8" | "base64";
	mediaType: string;
	captureKind: "agent_visible" | "auxiliary_capture" | "workspace_snapshot";
	completeness: "complete" | "truncated" | "unavailable";
	truncationDetails?: string;
	externalLocator?: string;
	versionIdentity?: string;
}
export interface Artifact extends Omit<ArtifactInput, "content" | "encoding"> {
	sessionId: string;
	id: string;
	hash: string;
	byteLength: number;
	storageRef: string;
	eventIds: string[];
}
export interface EventInput {
	kind: EventKind;
	producer: string;
	authority: "user" | "agent" | "tool" | "host";
	origin: Origin;
	timestamp: number;
	payload: string; // Exact visible text, never a generated summary of a result.
	message?: Json; // Exact host message for the tail. Not the writer's input.
	causalParentIds: string[];
	turnId?: string;
	toolCallId?: string;
	operationId?: string;
	operationStatus?: OperationStatus;
	deliveryState: "delivered" | "pending" | "unknown";
	coherentCut?: boolean;
	artifacts?: ArtifactInput[];
	truncationMetadata?: Json;
	workspaceVersion?: string;
	observationScope?: string;
	entities?: string[];
	respondsToEventIds?: string[];
	originalEvidenceIds?: string[]; // Retrieval is not independent confirmation.
}
export interface SourceEvent extends Omit<EventInput, "payload" | "message" | "artifacts"> {
	sessionId: string;
	id: string;
	producerEventId: string;
	sequence: number; // Physical ingestion order, including non-original records.
	originalSequence?: number; // Only original events receive an owned position.
	inputDigest: string;
	payloadRef: string;
	messageRef?: string;
	artifactIds: string[];
	visibleTokens: number;
	tokenizerId: string;
}
export interface EvidenceRef {
	sessionId: string;
	eventId: string;
	artifactId?: string;
	span?: { start: number; end: number; encoding: "utf8" }; // Half-open byte offsets.
	quote?: string; // Exact unique literal, deterministically resolved to a span.
	contentHash?: string;
	workspaceVersion?: string;
	observationScope: string;
}
export interface Snapshot {
	sessionId: string;
	id: string;
	start: number;
	end: number;
	eventIds: string[];
	sourceDigest: string;
	manifestRef: string;
	visibleTokens: number;
	tokenizerId: string;
	segmentationVersion: string;
	createdAt: number;
	oversizedReason?: string;
}
export type ItemStatus = "active" | "deferred" | "completed" | "cancelled" | "superseded" | "unresolved";
export type ItemKind = "objective" | "task" | "constraint" | "exclusion" | "acceptance_criterion" | "question" | "preference_inference";
export interface WorkItem {
	id: string;
	kind: ItemKind;
	statement: string;
	origin: "explicit_user" | "inferred_user" | "agent_proposal";
	scope: string;
	conditions: string[];
	status: ItemStatus;
	sourceRefs: EvidenceRef[];
	exactUserExcerptRefs: EvidenceRef[];
	dependencies: string[];
	parentId?: string;
	supersedesIds: string[];
	supersededByIds: string[];
	completionEvidence: EvidenceRef[];
	deferralReason?: string;
	inferenceBasis?: string;
	conflicts: string[];
	createdAt: number;
	lastTransition: number;
	version: number;
}
export type ClaimCategory = "explicit_user" | "inferred_user" | "agent_proposal" | "hypothesis" | "observation" | "planned" | "attempted" | "changed" | "tested" | "completed";
export interface Claim {
	id: string;
	category: ClaimCategory;
	text: string;
	scope: string;
	sourceRefs: EvidenceRef[];
	itemIds: string[];
	entities: string[];
	workspaceVersion?: string;
	invalidatesIds: string[];
}
export interface Receipt {
	eventId: string;
	itemIds: string[];
	classification: "requirements" | "change" | "answer" | "no_change";
	reason: string;
}
export interface Mutation {
	item: WorkItem;
	expectedVersion: number | null;
	atEventId: string;
	evidence: EvidenceRef[];
}
export interface ExtractionPage {
	schemaVersion: 1;
	claims: Claim[];
	mutations: Mutation[];
	receipts: Receipt[];
	complete: boolean;
	nextCursor: string | null;
}
export interface Review {
	verdict: "supported" | "unsupported" | "ambiguous";
	evidence: EvidenceRef[];
	explanation: string;
}
export interface Transition {
	mutation: Mutation;
	accepted: boolean;
	review?: Review;
	reason?: string;
}
export interface AliasRecord { aliasId: string; canonicalId: string; evidence: EvidenceRef[]; review: Review; reconciliationVersion: string }
export type DerivedUpdate = { kind: "regenerate_block"; blockId: string } | { kind: "reconcile"; requestId: string; expectedLedgerVersion: string; mutations: Mutation[]; aliases: { aliasId: string; canonicalId: string; evidence: EvidenceRef[] }[] };
export interface Ledger {
	version: string;
	aliases?: AliasRecord[];
	reconciliation?: { version: string; previousLedgerVersion: string; effectivePositions: number[]; reconciledThrough: number };
	cutoff: number;
	items: WorkItem[];
	claims: Claim[];
	operations: { id: string; status: OperationStatus; eventId: string }[];
	receipts: Receipt[];
	transitions: Transition[];
}
export interface Block {
	id: string;
	snapshotId: string;
	sourceDigest: string;
	ledgerVersion: string;
	title: string;
	claimIds: string[];
	content: Json;
	rendered: string;
	tokens: number;
	tokenizerId: string;
	jobId: string;
	writerPromptVersion: string;
	modelIdentity: string;
	validationRef: string;
	archiveRef: string;
	supersedesBlockVersion?: string;
}
export interface Job {
	id: string;
	kind: "writer" | "reviewer" | "block" | "trajectory";
	inputDigest: string;
	inputRef: string;
	promptVersion: string;
	modelIdentity: string;
	tokenizerId: string;
	state: "running" | "complete" | "invalid";
	responses?: { callId: string; attempt: number; receivedAt: number; responseRef: string }[];
	attempts: { startedAt: number; durationMs: number; error?: string; outputRef?: string; tokens?: number; inputTokens?: number; providerUsage?: Json[] }[];
	leaseUntil: number;
	output?: Json;
}
export const CATEGORIES = ["Goal", "Progress", "Remaining Work", "Blockers"] as const;
export type Category = typeof CATEGORIES[number];
export interface TrajectoryPlan {
	schemaVersion: 1;
	cutoff: number;
	entries: { itemId: string; category: Category }[];
	nextAction: { text: string; origin: "agent_proposal"; itemIds: string[]; evidenceBlockIds: string[]; retrievalPrerequisites: string[] };
	conflictIds: string[];
	requiredBlockIds: string[];
}
export interface Config {
	version: string;
	snapshotMin: number;
	snapshotTarget: number;
	snapshotMax: number;
	blockPreferred: number;
	blockMax: number;
	historyMax: number;
	trajectoryMax: number;
	continuityMax: number;
	tailPreferred: number;
	tailPlanningMax: number;
	writerInputMax: number;
	writerOutputMax: number;
	writerPageMax: number;
	writerBatchEvents: number;
	repairs: number;
	jobTimeoutMs: number;
	stopWords: string[];
}
export const DEFAULT_CONFIG: Config = {
	version: "l-mem-1", snapshotMin: 10_000, snapshotTarget: 12_500, snapshotMax: 15_000,
	blockPreferred: 1_500, blockMax: 4_000, historyMax: 30_000, trajectoryMax: 5_000,
	continuityMax: 35_000, tailPreferred: 2_000, tailPlanningMax: 8_000,
	writerInputMax: 40_000, writerOutputMax: 12_000, writerPageMax: 128, writerBatchEvents: 8,
	repairs: 2, jobTimeoutMs: 120_000,
	stopWords: ["the", "and", "for", "with", "that", "this", "from", "into", "have", "was", "are", "not", "but", "you"],
};
export interface Tokenizer {
	id: string;
	mode: "exact" | "conservative";
	count(serialized: string): number;
}
export interface ModelBinding {
	identity: string;
	invoke(job: { kind: Job["kind"]; prompt: string; input: Json; maxOutputTokens: number; signal: AbortSignal; onUsage?: (usage: Json) => void; onResponse?: (response: Json) => void }): Promise<Json>;
}
export interface ContextRequest {
	requestId: string;
	contextRevision: string;
	capacity: number;
	fixedTokens: number;
	outputReserve: number;
	safetyMargin: number;
	unactedUserEventIds: string[];
	/** Original protocol inputs required for the current continuation. */
	exactTailEventIds?: string[];
	cutoff?: number;
	/** Prefer the newest legal cutoff, without requiring a split of sealed ownership. */
	preferLatestCutoff?: boolean;
}
export interface RenderInput {
	history: Json[];
	trajectory: Json;
	tail: { event: SourceEvent; message: Json }[];
	support: { event: SourceEvent; message: Json }[];
	controls?: { event: SourceEvent; message: Json }[];
}
export interface Rendered {
	accounting?: { profile: string; supplementalTokens: number; excludedEncodedBytes: number; responseRefs: string[] };
	history: string;
	trajectory: string;
	tail: string;
	payload: Json;
	// The host must count the final request and charge any additional framing to a partition.
	counts: { history: number; trajectory: number; tail: number; total: number };
}
export interface HostBinding {
	version: string;
	archiveCapability: string;
	render(input: RenderInput, tokenizer: Tokenizer): Rendered;
	validateTail(tail: SourceEvent[], support: SourceEvent[]): Result<null>;
	protocolSupport?(tail: SourceEvent[], support: SourceEvent[]): SourceEvent[];
	// Synchronous barrier/CAS callback: no model calls inside. The host joins ingestion,
	// activation and next-request selection, and persists accepted/sent/unknown dispatch state.
	dispatch?: {
		activate(sessionId: string, handoffId: string, expectedRevision: string,
			refresh: () => Result<Handoff>): Result<{ dispatchId: string; handoff: Handoff; state: "accepted" | "sent" | "unknown" }>;
	};
}
export interface Handoff {
	indexRefs?: string[];
	id: string;
	sessionId: string;
	request: ContextRequest;
	cutoff: number;
	watermark: number;
	ledgerVersion: string;
	snapshotIds: string[];
	selectedBlocks: { id: string; tier: number; score: number; reason: string }[];
	omittedBlockIds: string[];
	annotations: Json[];
	continuations: Json[];
	trajectory: Json;
	activeLocations: { itemId: string; location: string }[];
	tailEventIds: string[];
	supportEventIds: string[];
	controlEventIds?: string[];
	rendered: Rendered;
	renderInput: RenderInput;
	payloadRef: string;
	validationRef: string;
	configuration: Config;
	tokenizerId: string;
	hostVersion: string;
	state: "prepared";
	derivedRevision?: number;
}
export interface SessionState {
	schemaVersion: 2;
	sessionId: string;
	events: SourceEvent[];
	artifacts: Artifact[];
	snapshots: Snapshot[];
	ledgers: Ledger[];
	blocks: Block[];
	extractions: { snapshotId: string; pages: ExtractionPage[] }[];
	jobs: Job[];
	handoffs: Handoff[];
	activations: { handoffId: string; preparationHandoffId: string; dispatchId: string; state: "accepted" | "sent" | "unknown"; watermark: number }[];
	failures: Failure[];
	lookupCount: number;
	host?: import("./host-runtime.ts").HostState;
	derivedRevision?: number;
	minimumHandoffCutoff?: number;
	derivedUpdates?: { inputDigest: string; kind: DerivedUpdate["kind"]; resultId: string }[];
	migrations?: { from: 1; to: 2; previousManifestRef: string; appliedAt: number }[];
	legacyHandoffIds?: string[];
}
export interface Store {
	load(sessionId: string): { revision: number; state: SessionState };
	compareAndSwap(sessionId: string, expectedRevision: number, state: SessionState): boolean;
	put(sessionId: string, bytes: Uint8Array, suffix: "txt" | "json" | "bin"): string;
	read(sessionId: string, ref: string): Uint8Array;
	close?(): void;
}
export type LookupQuery =
	| { kind: "reference"; ref: string; offset?: number }
	| { kind: "events"; start: number; end: number }
	| { kind: "search"; text: string }
	| { kind: "block" | "item"; id: string };
export interface LookupResult {
	results: Json[];
	continuation: LookupQuery | null;
	tokens: number;
}
