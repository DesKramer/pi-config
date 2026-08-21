# Minimal Subagents

A [pi](https://github.com/earendil-works/pi) extension that registers a single `subagent` tool with these agents:

| Agent | Tools | Model | Purpose |
|-------|-------|-------|---------|
| **scout** | read, grep, find, ls, mem0_memory | openai-codex/gpt-5.6-sol (max) | Fast codebase recon with explicit local-memory search/add |
| **orchestrator** | subagent | openai-codex/gpt-5.6-sol (max) | Coordinates autonomous improvement campaigns |
| **researcher** | read, grep, find, ls, subagent | openai-codex/gpt-5.6-sol (max) | Investigates opportunities and proposes experiments |
| **experimenter** | read, write, edit, safe_bash, subagent | openai-codex/gpt-5.6-sol (max) | Implements and measures bounded experiments |
| **evaluator** | read, grep, find, ls, safe_bash, web_search, fetch_content, subagent | openai-codex/gpt-5.6-sol (max) | Independently evaluates candidates |
| **web-researcher** | web_search, fetch_content, firecrawl_search, firecrawl_scrape | openai-codex/gpt-5.6-sol (max) | Web research |
| **worker** | read, write, edit, safe_bash, web_search, fetch_content, subagent, mem0_memory | openai-codex/gpt-5.6-sol (max) | Code changes with explicit local-memory search/add (can dispatch scout/web-researcher to protect its own context) |
| **acceptance-criteria** | read, grep, find | openai-codex/gpt-5.6-sol (max) | Derives testable acceptance criteria and identifies ambiguities |
| **qa** | read, grep, find, safe_bash | openai-codex/gpt-5.6-sol (max) | QA gate for a completed, integrated cycle of worker changes |

Agent recursion is constrained with `subagent_agents` allowlists. The orchestrator can dispatch researcher, experimenter, and evaluator; nested agents can only dispatch their compatible focused helpers.

## Dependencies

`safe_bash` ships in this repo (`tools/safe-bash.ts`). This local install maps `web_search` and `fetch_content` to the installed `pi-web-access` package under `~/.pi/agent/npm/node_modules/pi-web-access/index.ts`, `firecrawl_search`/`firecrawl_scrape` to `firecrawl-tools.ts`, and `mem0_memory` to `mem0.ts`. The Mem0 tool is available only to worker and scout; it still searches/adds only on explicit user requests.

## Usage

Run `/agents` in the TUI to choose between **Availability** and the existing **Models & reasoning** editor. Availability uses Pi's SettingsList controls: select a profile and press Enter/Space to toggle it. The model editor still lets you select an agent, fuzzy-search Pi's configured model registry by provider/model/display name, and choose a supported reasoning level.

Both availability and model/reasoning overrides apply only to the current Pi runtime and reset when the extension initializes or reloads. All profiles default enabled. A user-disabled profile is omitted from workflow/orchestrator advertising, rejected before a subagent process can spawn, and reported separately from an unknown name. Extension-owned temporary restrictions (for example, an active workflow step allowlist) are intersected with—but never mutate—the user's `/agents` choices. Changes made with `/agents` while restricted take effect when the restriction clears.

When the host exposes command notifications, non-TUI command modes include `[enabled]`/`[disabled]` in the `/agents` summary. Availability can be changed in any command-capable mode:

```text
/agents enable <name>
/agents disable <name>
/agents toggle <name>
/agents enable all
/agents disable all
/agents toggle all
```

One tool call = one subagent:
```json
{ "agent": "scout", "task": "Find all auth-related files in src/" }
```

To fan out, emit multiple `subagent` tool calls in the same assistant turn — pi runs them in parallel automatically. A per-process semaphore caps simultaneous subagents at `maxConcurrency` (default 4); calls past the cap wait their turn.

Each subagent runs as an isolated `pi` process with no inherited context — all context must be in the task description. Ordinary task descriptions are not size-limited by this extension; long tasks are passed to the child through a temporary file.

## Config

Optional `config.json` next to `index.ts`:

```json
{ "maxConcurrency": 4 }
```

## Output

Subagents return text only — there's no file handoff. If the parent needs artifacts, instruct the subagent to `write` them and return the path.

Large outputs (>`DEFAULT_MAX_BYTES`) are head-truncated before being returned to the parent.

Every started logical invocation returns structured `details.results[0]` evidence in addition to text output:

- `invocationId` is the host tool-call ID and remains stable for that invocation; `attempt` is always `{ number: 1, maxAttempts: 1 }` because this extension never retries.
- `context` preserves the requested agent, task, working directory, and effective model/thinking settings.
- `outcome` is `completed`, `failed`, or `cancelled`. Observable failures are classified as `cancelled`, `spawn_failure`, `provider_failure`, `nonzero_exit`, or conservative generic `failure`.
- `output`, `progress.recentTools`, and usage retain partial evidence available before failure. `sideEffectsMayHaveOccurred` becomes true when an observed tool is not on the known read-only list.
- `retryability` is `retryable`, `not_retryable`, or `unknown`. It is only a conservative hint; no failed work is automatically replayed.

### Durable branch-local failure checkpoints and repair linkage

Failed and cancelled terminal outcomes are persisted as version `1` `pi-subagent-checkpoint` custom entries before the tool returns. The append-only record stream contains `failure`, `repair-started`, and `repair-finished` records. Checkpoints store bounded evidence rather than child sessions: task snapshots and serialized repair objectives are capped at 8 KiB, output at 16 KiB, error at 2 KiB, and only the latest 20 tool calls are retained; each serialized entry is capped at 64 KiB. Prior evidence and the explicit objective injected into a repair child are also bounded. Child sessions are never persisted or resumed.

On `session_start` and `session_tree`, the extension reconstructs state exclusively from `ctx.sessionManager.getBranch()`, so failures from other tree branches are not repairable or exposed. At most the 50 most recent unresolved chains are retained in memory. A `repair-started` record without a matching finish after restart is shown as interrupted; it is never resumed, and its original failure remains available for a new explicit repair.

A repair is a new logical invocation, not another attempt. Pass `repairOfInvocationId` with an explicit `task` containing the repair objective:

```json
{ "agent": "worker", "task": "Repair only the failing parser assertion; preserve unrelated edits.", "repairOfInvocationId": "prior-tool-call-id" }
```

The ID must name an unresolved failed/cancelled checkpoint on the current branch. The extension creates a new invocation ID, writes `repair-started`, and launches one fresh child with bounded prior evidence plus the explicit objective. It never automatically retries or replays the original task. A terminal repair writes `repair-finished` before returning: success resolves the prior failure; failed/cancelled repair becomes the new unresolved, explicitly linked failure in that chain.

Up to 5 unresolved chains (12 KiB total) are conservatively exposed in the parent prompt, with instructions not to replay automatically. `/subagent-checkpoints` gives a concise branch-local summary and identifies interrupted repairs.

Session storage is append-only: the extension bounds each new record and its restored/in-memory view, but cannot physically prune historical checkpoint entries already present in the session file.

## UI

Two levels, toggled with `ctrl+o`:

- **Collapsed (default):** the tool call shows one line — `subagent <agent> <60-char task preview>`. The result block shows the agent header (status, tool count, duration), the chronological tool log (one line per call, running calls marked with `▸`), the latest prose "thinking" line, and a usage line (tokens in/out, cache, cost, context-window gauge).
- **Expanded:** the call header streams the full task body live as the parent writes it (like `write`/`edit`). The result block additionally renders the subagent's full final output as markdown. Nested children (when a worker spawns scout/web-researcher) render inline, indented under the row that dispatched them, with their own per-row context gauge.

## Registering Agents from Other Extensions

Other extensions can dynamically register and unregister agents at runtime. This is useful for domain-specific agents that should only be available when a particular extension is active.

### 1. Define agent `.md` files

Create markdown files with YAML frontmatter in your extension's directory (e.g. `my-extension/agents/my-agent.md`):

```markdown
---
name: my-agent
description: Does a specific thing
tools: web_search, video_extract
model: claude-sonnet-4-20250514
---

You are an agent that does a specific thing...
```

Frontmatter fields:
- **name** (required) — unique agent name, used in `{ agent: "my-agent" }` calls
- **description** — short description
- **tools** — comma-separated list of tools the agent needs (builtin or extension). Include `subagent` here to let this agent spawn other agents.
- **model** — model identifier (defaults to `cosine/glm-5.2`)
- **thinking** — reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` (defaults to `medium`; model support may narrow this list)
- **subagent_agents** — if `subagent` is in `tools`, restrict which agents this one may spawn. Comma-separated list of agent names. Omit for no profile restriction. Enforced by passing `PI_SUBAGENT_ALLOWED` to the child process. At spawn time this allowlist is intersected with the parent session's enabled profiles; an unrestricted parent likewise passes only enabled profiles when any are disabled. Thus session availability never broadens a profile allowlist, and nested agents cannot see disabled profiles.

The markdown body becomes the agent's system prompt.

### 2. Register agents via `globalThis.__pi_subagents`

Pi loads extensions via jiti, which creates separate module instances. Direct imports from the subagents extension will reference a different `agents` array than the one the `subagent` tool uses. Use the `globalThis` bridge instead:

```typescript
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

interface AgentConfig {
  name: string;
  description: string;
  tools: string[];
  model: string;
  thinking: string;        // supported level such as "medium", "xhigh", or "max"
  systemPrompt: string;
  filePath: string;
  subagentAgents?: string[]; // optional spawn-allowlist; [] explicitly allows none
}

type AgentMetadata = Omit<AgentConfig, "systemPrompt"> & {
  enabled: boolean;              // effective runtime availability
  userEnabled: boolean;          // session-level /agents choice
  temporarilyRestricted: boolean;
};

const AGENTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "agents");

function registerMyAgents(): void {
  const subagents = (globalThis as any).__pi_subagents as
    | {
        registerAgent: (config: AgentConfig) => void;
        unregisterAgent: (name: string) => void;
        listAgents: () => AgentMetadata[]; // read-only metadata copy
        setAgentEnabled: (name: string, enabled: boolean) => boolean;
        setTemporaryAgentRestriction: (owner: string, allowed: readonly string[]) => boolean;
        clearTemporaryAgentRestriction: (owner: string) => boolean;
      }
    | undefined;
  if (!subagents) return; // subagents extension not loaded

  for (const entry of fs.readdirSync(AGENTS_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(AGENTS_DIR, entry);
    const content = fs.readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name) continue;

    const tools = (frontmatter.tools || "").split(",").map(t => t.trim()).filter(Boolean);
    const subagentAgents = frontmatter.subagent_agents
      ? frontmatter.subagent_agents.split(",").map(t => t.trim()).filter(Boolean)
      : undefined;
    try {
      subagents.registerAgent({
        name: frontmatter.name,
        description: frontmatter.description || "",
        tools,
        model: frontmatter.model || "cosine/glm-5.2",
        thinking: frontmatter.thinking || "medium",
        systemPrompt: body,
        filePath,
        ...(subagentAgents ? { subagentAgents } : {}),
      });
    } catch {
      // Already registered — skip
    }
  }
}
```

Call `registerMyAgents()` when your extension activates (e.g. in a command handler). The agents become available to the `subagent` tool immediately.

Use `subagents.listAgents()` when another extension needs read-only metadata for validation or UI. It returns copies of registered configs plus user and effective availability; consumers should filter `enabled === false` profiles before advertising or accepting them. Do not mutate returned objects. `setAgentEnabled(name, enabled)` changes the user's runtime-only choice. Extensions that need temporary enforcement should instead use an owner-keyed `setTemporaryAgentRestriction()`/`clearTemporaryAgentRestriction()` pair. Restrictions intersect, emit effective availability changes, and leave `/agents` choices intact.

### 3. Adding custom tool support

If your agents need tools beyond the built-in set, those tools must be mapped in the `CUSTOM_TOOL_EXTENSIONS` record in `subagents/index.ts`:

```typescript
const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
  web_search: path.join(EXT_BASE, "web-search", "index.ts"),
  web_fetch: path.join(EXT_BASE, "web-fetch", "index.ts"),
  safe_bash: path.join(TOOLS_DIR, "safe-bash.ts"),
  video_extract: path.join(EXT_BASE, "video-extract", "index.ts"),
  youtube_search: path.join(EXT_BASE, "youtube-search", "index.ts"),
  google_image_search: path.join(EXT_BASE, "google-image-search", "index.ts"),
};
```

Built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) work automatically. Any other tool the agent lists in its frontmatter must have a corresponding entry here pointing to the extension's `index.ts`.

The `subagent` tool itself is listed in `CUSTOM_TOOL_EXTENSIONS` pointing back to this extension's own `index.ts` — that's how an agent like `worker` can recursively spawn other agents. Recursion is bounded only by each agent's `subagent_agents` allowlist (e.g. worker can spawn scout/web-researcher, neither of which declares the `subagent` tool, so the chain stops at depth 2).

## Structure

```
subagents/
├── index.ts           # Extension entry point
├── agents/            # Built-in agent configs (frontmatter + system prompt)
└── tools/             # Extensions loaded into subagent processes
    └── safe-bash.ts   # bash with dangerous command blocking
```
