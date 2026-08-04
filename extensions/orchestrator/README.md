# orchestrator

Appends an **Orchestration Mode** layer to the system prompt on every turn via
the `before_agent_start` hook. The layer steers the agent to act as an
orchestrator — owning the conversation with the user while delegating the
actual work to subagents via the `subagent` tool (see
[`../pi-subagents`](../pi-subagents)).

## Behavior

- **On by default.** Every turn gets the layer appended to the system prompt.
- **`/orchestrator`** toggles the layer on/off for the current session and
  shows a confirmation notification.

## Subagent Registry

The layer includes a registry table (`| name | description | tools |`)
auto-generated at session start by parsing the frontmatter of every `.md` file
in `../pi-subagents/agents/`. It is parsed once and cached — files are not
re-read every turn. If the agents directory is missing or a file is
unparsable, the table is omitted gracefully (no error).

Dependency-free: Node `fs`/`path` only.
