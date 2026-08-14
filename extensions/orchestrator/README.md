# orchestrator

Appends an **Orchestration Mode** layer to the system prompt on every turn via
the `before_agent_start` hook. The layer steers the agent to act as an
orchestrator — owning the conversation with the user while delegating the
actual work to subagents via the `subagent` tool (see
[`../pi-subagents`](../pi-subagents)).

## Behavior

- **On by default.** Every normal turn gets the layer appended to the system prompt.
- **Workflow-aware.** A running `pi-workflow` owns the prompt, so the generic layer is suppressed until the workflow pauses or ends.
- **`/orchestrator`** toggles the layer on/off for the current session and
  shows a confirmation notification.

## Subagent Registry

The layer includes a registry table (`| name | description | tools |`) built
from `pi-subagents`' live `globalThis.__pi_subagents.listAgents()` metadata on
every turn. Only currently enabled profiles are advertised, so `/agents`
availability changes and dynamic registration/unregistration take effect
without stale caches. If the bridge is unavailable or no profiles are enabled,
the prompt explicitly says that no subagents should be called.
