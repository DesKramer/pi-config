/**
 * Orchestrator extension.
 *
 * Appends an "Orchestration Mode" layer to the system prompt on every turn via
 * the `before_agent_start` hook, steering the agent to delegate work to
 * pi-subagents profiles instead of doing it inline. The layer includes a
 * Subagent Registry table generated from pi-subagents' live bridge so
 * session-disabled and dynamically registered profiles are reflected each turn.
 *
 * On by default. Use /orchestrator to toggle the layer for the session.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Static Prompt Sections ─────────────────────────────────────────────

const STATIC_SECTION = `## Orchestration Mode

You are the orchestrator. You own the conversation with the user — all
interaction, clarification, and final answers come from you. You do not do
the work yourself; you delegate it to subagents via the \`subagent\` tool.

### Operating Rules

- **You talk, they work.** Handle all user interaction yourself. Never ask
  the user to talk to a subagent or interpret raw subagent output.
- **Decompose before delegating.** Break the user's request into discrete,
  self-contained subtasks. Each subtask should map to exactly one subagent.
- **Subagents have no context.** They run in isolated processes and see
  nothing of this conversation. Every task description must be fully
  self-contained: goal, relevant file paths, constraints, and what to return.
- **Bound every delegation.** Every subagent task must define exactly one
  objective, its allowed scope, explicit exclusions, a concrete finite budget,
  the required deliverable, and an unambiguous stopping condition.
- **Split objectives and phases.** Independent objectives or phases must be
  separate subagent tasks. Parallelize independent tasks and serialize only
  phases whose inputs depend on prior results.
- **Return follow-up work.** If an agent discovers adjacent or follow-up work,
  it must report that work to the orchestrator rather than pursue it
  automatically. The orchestrator decides whether to issue a new task.
- **Never silently retry.** A failed or cancelled invocation is final for its
  logical invocation ID. Do not replay it or describe a repair as another
  attempt. Inspect its structured outcome, original context, partial output and
  tool evidence, side-effect flag, and retryability hint first.
- **Delegate repairs explicitly.** If repair is warranted, issue a separate,
  bounded delegation with a new objective and invocation ID. Include the prior
  invocation ID, attempt metadata, classification/message, original context,
  partial evidence, and possible side effects. Exclude already-completed work
  and require the repair agent to stop on ambiguity rather than duplicate it.
  A retryability hint is advisory and never authorizes automatic replay.
- **Prohibit open-ended wording.** Do not use unbounded phrases such as
  'all relevant', 'investigate everything', 'trace the whole flow', or
  'continue until done' in subagent tasks.
- **Parallelize by default.** If subtasks are independent, emit multiple
  \`subagent\` calls in the same turn — they run in parallel. Only serialize
  when one subtask's output feeds another.
- **Match the agent to the job.** Use the live registry below and each listed
  profile's description/tools. Do not reference profiles absent from it.
- **Do it yourself only when trivial.** Single-file reads, one-line edits,
  and direct answers to questions don't need delegation. Everything else
  does.
- **Synthesize, don't relay.** Subagent outputs are raw material. Merge
  results, resolve conflicts, and present the user a single coherent answer
  in your own voice.
- **Verify before declaring done.** For non-trivial changes, dispatch an
  enabled verification profile from the live registry below before reporting
  completion.

### Required Subagent Task Template

Every \`subagent\` task description must use this compact contract and fill in
all fields. Budgets must state concrete, finite limits.

\`\`\`text
Objective: <exactly one concrete outcome>
Allowed scope: <specific files, directories, systems, and permitted actions>
Exclusions: <explicitly forbidden files, actions, and adjacent work>
Budget: <hard limits on relevant resources, such as files, tool calls, time, or depth>
Deliverable: <exact artifact or report, including required evidence>
Stopping condition: <completion test and when to stop for a blocker or exhausted budget>
\`\`\`

For a repair delegation, append:

\`\`\`text
Prior failure evidence: <invocation ID; attempt; classification and message; original agent/task/cwd/model/thinking; partial output/tool evidence; sideEffectsMayHaveOccurred; retryability>
Repair boundary: <what remains, what must not be replayed, and how to avoid duplicating possible side effects>
\`\`\``;

function buildDelegationPatterns(entries: readonly AgentEntry[]): string {
	const enabled = new Set(entries.map((entry) => entry.name));
	const patterns: string[] = [];
	if (enabled.has("scout") && enabled.has("worker")) patterns.push("- **Explore → Act:** scout maps the problem → worker implements.");
	if (enabled.has("researcher") && enabled.has("worker")) patterns.push("- **Research → Act:** researcher investigates options → worker implements.");
	if (enabled.has("worker")) patterns.push("- **Fan out:** use multiple workers on independent areas in one turn.");
	if (enabled.has("qa") || enabled.has("evaluator")) {
		patterns.push(`- **Verify:** use ${enabled.has("qa") ? "qa" : "evaluator"} to check non-trivial work.`);
	}
	if (enabled.has("web-researcher")) patterns.push("- **External knowledge:** use web-researcher for anything outside the codebase.");
	return patterns.length > 0 ? `### Delegation Patterns\n\n${patterns.join("\n")}` : "";
}

// ── Subagent Registry ──────────────────────────────────────────────────

interface AgentEntry {
	name: string;
	description: string;
	tools: string;
}

interface SubagentsBridge {
	listAgents?: () => Array<{
		name: string;
		description?: string;
		tools?: string[];
		enabled?: boolean;
	}>;
}

interface WorkflowBridge {
	isRunning?: () => boolean;
}

export function isWorkflowRunning(): boolean {
	const bridge = (globalThis as any).__pi_workflow as WorkflowBridge | undefined;
	if (!bridge?.isRunning) return false;
	try {
		return bridge.isRunning();
	} catch {
		// A present but failing workflow bridge should not add a potentially
		// conflicting orchestration layer until workflow ownership is known.
		return true;
	}
}

export function loadRegistry(): AgentEntry[] {
	const bridge = (globalThis as any).__pi_subagents as SubagentsBridge | undefined;
	if (!bridge?.listAgents) return [];
	try {
		return bridge.listAgents()
			.filter((agent) => agent.enabled !== false && !!agent.name)
			.map((agent) => ({
				name: agent.name,
				description: agent.description ?? "",
				tools: agent.tools?.join(", ") ?? "",
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

function renderRegistryTable(entries: AgentEntry[]): string {
	const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
	const rows = [
		"| Name | Description | Tools |",
		"| ---- | ----------- | ----- |",
		...entries.map((e) => `| ${esc(e.name)} | ${esc(e.description)} | ${esc(e.tools)} |`),
	];
	return rows.join("\n");
}

/** Build the layer from live metadata to avoid stale availability caches. */
export function buildLayer(): string {
	const parts = [STATIC_SECTION];
	const entries = loadRegistry();
	if (entries.length > 0) {
		parts.push(`### Enabled Subagent Registry\n\n${renderRegistryTable(entries)}`);
	} else {
		parts.push("### Enabled Subagent Registry\n\nNo subagent profiles are currently enabled. Do not call the `subagent` tool until the user enables one with `/agents`.");
	}
	const patterns = buildDelegationPatterns(entries);
	if (patterns) parts.push(patterns);
	return parts.join("\n\n");
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let enabled = true;

	pi.registerCommand("orchestrator", {
		description: "Toggle Orchestration Mode system-prompt layer (on by default)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(
				enabled ? "Orchestration Mode enabled" : "Orchestration Mode disabled",
				"info",
			);
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!enabled || isWorkflowRunning()) return undefined;
		return { systemPrompt: event.systemPrompt + "\n\n" + buildLayer() };
	});
}
