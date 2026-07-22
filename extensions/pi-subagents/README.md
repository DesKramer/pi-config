# Minimal Subagents

A [pi](https://github.com/earendil-works/pi) extension that registers a single `subagent` tool with these agents:

| Agent | Tools | Model | Purpose |
|-------|-------|-------|---------|
| **scout** | read, grep, find, ls, mem0_memory | gpt-5.5 (medium) | Fast codebase recon with explicit local-memory search/add |
| **orchestrator** | subagent | gpt-5.5 (medium) | Coordinates autonomous improvement campaigns |
| **researcher** | read/search tools, subagent | gpt-5.5 (medium) | Investigates opportunities and proposes experiments |
| **experimenter** | read, write, edit, safe_bash, subagent | gpt-5.5 (medium) | Implements and measures bounded experiments |
| **evaluator** | read/search tools, safe_bash, subagent | gpt-5.5 (medium) | Independently evaluates candidates |
| **historian** | read, write, edit | gpt-5.5 (medium) | Maintains concise campaign memory |
| **web-researcher** | web_search, fetch_content, firecrawl_search, firecrawl_scrape | gpt-5.5 (high) | Web research |
| **worker** | read, write, edit, safe_bash, web_search, fetch_content, subagent, mem0_memory | gpt-5.5 (high) | Code changes with explicit local-memory search/add (can dispatch scout/web-researcher to protect its own context) |
| **acceptance-criteria** | read, grep, find | gpt-5.5 (medium) | Derives testable acceptance criteria and identifies ambiguities |
| **qa** | read, grep, find, safe_bash | gpt-5.5 (medium) | Runs focused read-only QA and reports evidence |

Agent recursion is constrained with `subagent_agents` allowlists. The orchestrator can dispatch the four campaign agents; those agents can only dispatch compatible focused helpers, and the historian cannot spawn agents.

## Dependencies

`safe_bash` ships in this repo (`tools/safe-bash.ts`). This local install maps `web_search` and `fetch_content` to the installed `pi-web-access` package under `~/.pi/agent/npm/node_modules/pi-web-access/index.ts`, `firecrawl_search`/`firecrawl_scrape` to `firecrawl-tools.ts`, and `mem0_memory` to `mem0.ts`. The Mem0 tool is available only to worker and scout; it still searches/adds only on explicit user requests.

## Usage

Run `/agents` in the TUI to open a list of registered agents, including each agent's description, effective model, thinking level, and tools. Select an agent, then type in the model picker to fuzzy-search Pi's configured model registry by provider, model ID, or display name. After choosing a model, select a reasoning level supported by that model. Changes apply to subsequent runs in the current Pi session only; canceling any picker leaves the agent unchanged, and restarting or reloading Pi restores the agent definitions.

One tool call = one subagent:
```json
{ "agent": "scout", "task": "Find all auth-related files in src/" }
```

To fan out, emit multiple `subagent` tool calls in the same assistant turn — pi runs them in parallel automatically. A per-process semaphore caps simultaneous subagents at `maxConcurrency` (default 4); calls past the cap wait their turn.

Each subagent runs as an isolated `pi` process with no inherited context — all context must be in the task description.

## Config

Optional `config.json` next to `index.ts`:

```json
{ "maxConcurrency": 4 }
```

## Output

Subagents return text only — there's no file handoff. If the parent needs artifacts, instruct the subagent to `write` them and return the path.

Large outputs (>`DEFAULT_MAX_BYTES`) are head-truncated before being returned to the parent.

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
- **model** — model identifier (defaults to `anthropic/claude-sonnet-4-6`)
- **thinking** — reasoning level: `off`, `low`, `medium`, `high` (defaults to `medium`)
- **subagent_agents** — if `subagent` is in `tools`, restrict which agents this one may spawn. Comma-separated list of agent names. Omit for no restriction. Enforced by passing `PI_SUBAGENT_ALLOWED` env to the child `pi` process — the child's subagents extension filters its registry before any tool description sees it, so the child LLM literally can't reference an agent outside the allowlist.

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
  thinking: string;        // "off" | "low" | "medium" | "high"
  systemPrompt: string;
  filePath: string;
  subagentAgents?: string[]; // optional spawn-allowlist when `subagent` is in tools
}

type AgentMetadata = Omit<AgentConfig, "systemPrompt">;

const AGENTS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "agents");

function registerMyAgents(): void {
  const subagents = (globalThis as any).__pi_subagents as
    | {
        registerAgent: (config: AgentConfig) => void;
        unregisterAgent: (name: string) => void;
        listAgents: () => AgentMetadata[]; // read-only metadata copy
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
        model: frontmatter.model || "anthropic/claude-sonnet-4-6",
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

Use `subagents.listAgents()` when another extension needs read-only metadata for validation or UI. It returns copies of the registered agent configs; do not mutate them expecting registry changes.

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
