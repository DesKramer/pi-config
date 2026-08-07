/**
 * Orchestrator extension.
 *
 * Appends an "Orchestration Mode" layer to the system prompt on every turn via
 * the `before_agent_start` hook, steering the agent to delegate work to
 * pi-subagents profiles instead of doing it inline. The layer includes a
 * Subagent Registry table auto-generated once per session from the frontmatter
 * of the agent .md files in extensions/pi-subagents/agents/.
 *
 * On by default. Use /orchestrator to toggle the layer for the session.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Config ─────────────────────────────────────────────────────────────

const EXT_DIR = path.dirname(new URL(import.meta.url).pathname);
const AGENTS_DIR = path.join(path.dirname(EXT_DIR), "pi-subagents", "agents");

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
- **Prohibit open-ended wording.** Do not use unbounded phrases such as
  'all relevant', 'investigate everything', 'trace the whole flow', or
  'continue until done' in subagent tasks.
- **Parallelize by default.** If subtasks are independent, emit multiple
  \`subagent\` calls in the same turn — they run in parallel. Only serialize
  when one subtask's output feeds another.
- **Match the agent to the job.** Use the registry below. Don't send research
  to a worker or edits to a scout.
- **Do it yourself only when trivial.** Single-file reads, one-line edits,
  and direct answers to questions don't need delegation. Everything else
  does.
- **Synthesize, don't relay.** Subagent outputs are raw material. Merge
  results, resolve conflicts, and present the user a single coherent answer
  in your own voice.
- **Verify before declaring done.** For non-trivial changes, dispatch \`qa\`
  or \`acceptance-criteria\` to check the work before reporting completion.

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
\`\`\``;

const DELEGATION_PATTERNS = `### Delegation Patterns

- **Explore → Act:** scout/researcher to map the problem → worker to implement.
- **Fan out:** multiple scouts/workers on independent areas in one turn.
- **Implement → Verify:** worker/experimenter → qa or evaluator to check.
- **External knowledge:** web-researcher for anything outside the codebase.`;

// ── Subagent Registry ──────────────────────────────────────────────────

interface AgentEntry {
	name: string;
	description: string;
	tools: string;
}

/**
 * Minimal YAML-ish frontmatter parser: extracts flat `key: value` fields from
 * the `---` block at the top of a markdown file. Dependency-free by design —
 * agent frontmatter is flat, so a full YAML parser would be overkill.
 */
function parseFrontmatter(content: string): Record<string, string> {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return {};
	const fields: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/);
		if (kv) fields[kv[1]] = kv[2].trim();
	}
	return fields;
}

let registryCache: AgentEntry[] | undefined;

/**
 * Parse every agent .md file in the pi-subagents agents/ directory. Result is
 * cached after the first read — agent files don't change mid-session, and this
 * runs on the before_agent_start path which fires every turn.
 */
function loadRegistry(): AgentEntry[] {
	if (registryCache) return registryCache;
	const entries: AgentEntry[] = [];
	try {
		if (fs.existsSync(AGENTS_DIR)) {
			for (const entry of fs.readdirSync(AGENTS_DIR)) {
				if (!entry.endsWith(".md")) continue;
				try {
					const content = fs.readFileSync(path.join(AGENTS_DIR, entry), "utf-8");
					const frontmatter = parseFrontmatter(content);
					if (!frontmatter.name) continue;
					entries.push({
						name: frontmatter.name,
						description: frontmatter.description || "",
						tools: frontmatter.tools || "",
					});
				} catch {
					// Skip individual unparsable files
				}
			}
		}
	} catch {
		// Missing/unreadable directory — the table is omitted gracefully
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	registryCache = entries;
	return entries;
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

let layerCache: string | undefined;

/** Build the full prompt layer once, then serve from cache. */
function buildLayer(): string {
	if (layerCache !== undefined) return layerCache;
	const parts = [STATIC_SECTION];
	const entries = loadRegistry();
	if (entries.length > 0) {
		parts.push(`### Subagent Registry\n\n${renderRegistryTable(entries)}`);
	}
	parts.push(DELEGATION_PATTERNS);
	layerCache = parts.join("\n\n");
	return layerCache;
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
		if (!enabled) return undefined;
		return { systemPrompt: event.systemPrompt + "\n\n" + buildLayer() };
	});
}
