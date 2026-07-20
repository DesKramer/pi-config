# pi-workflow

`pi-workflow` is a v1 workflow runner for Pi sessions. It discovers trusted YAML workflow definitions, pins a normalized workflow snapshot when a run starts, injects only the current step into the agent prompt, and advances through an internal `workflow_checkpoint` tool.

## Install/copy workflow files

The extension discovers workflow files from:

1. `~/.pi/agent/workflows/*.yaml` and `*.yml`
2. the nearest trusted project `.pi/workflows/*.yaml` and `*.yml`

Project workflow names override user workflow names. Project workflows are ignored until Pi considers the project trusted (`ctx.isProjectTrusted()`).

This repository includes a sample workflow at:

```bash
workflows/feature-implementation.workflow.yaml
```

Copy it to a discovered location before running it, for example:

```bash
mkdir -p ~/.pi/agent/workflows
cp workflows/feature-implementation.workflow.yaml ~/.pi/agent/workflows/
```

or for a trusted project:

```bash
mkdir -p .pi/workflows
cp /path/to/pi-config/workflows/feature-implementation.workflow.yaml .pi/workflows/
```

The sample uses the `acceptance-criteria` and `qa` subagents added under `extensions/pi-subagents/agents/`.

## Commands

All commands are under `/workflow`:

- `/workflow list` — list discovered valid workflows and discovery diagnostics.
- `/workflow show <name|path>` — summarize a workflow.
- `/workflow validate [name|path]` — validate all discovered workflows, one discovered workflow, or a YAML file path.
- `/workflow run <name> <goal>` — start one active run for the current session/branch.
- `/workflow status` — show current run status, pinned hash, current step, and artifacts.
- `/workflow pause` — pause the active run and disable `workflow_checkpoint`.
- `/workflow resume` — resume a paused/interrupted run and re-enable `workflow_checkpoint`.
- `/workflow restart` — restart the last run from its pinned workflow snapshot.
- `/workflow cancel` — cancel the active run and disable `workflow_checkpoint`.

Only one workflow may be active in a session branch at a time. If a session is reloaded or branch-restored while a run was `running`, the extension restores it as `interrupted` and requires `/workflow resume`; it does not append restore entries.

## Workflow schema v1

```yaml
version: 1
name: example-workflow
description: Short human-readable description.
artifacts:
  artifact_name:
    type: text
    description: Optional description.
start: first_step
steps:
  first_step:
    type: main # main | delegate | end
    instructions: |
      Do the current step for {{input.goal}}.
    outputs:
      - artifact_name
    transitions:
      done: finished
  finished:
    type: end
    status: completed # completed (default) | canceled | failed
```

### Step types

- `main` — the primary agent performs the step.
- `delegate` — the primary agent is instructed to call a subagent, then summarize results in `workflow_checkpoint`.
- `end` — terminal step; it may include final summary instructions, but has no outputs, delegate config, or transitions.

`main` and `delegate` steps require `instructions` and non-empty `transitions`. A transition is normally a target step id. For clarification, abort, or blocked paths that cannot produce the step's normal outputs, use the expanded form:

```yaml
transitions:
  ready: next_step
  abort:
    target: canceled
    requireOutputs: false
```

`requireOutputs` defaults to `true`.

Delegate steps require exactly one of three forms:

```yaml
delegate:
  agent: qa # one fixed subagent call
  task: Verify {{input.goal}}.
```

```yaml
delegate:
  tasks: # fixed task list
    - agent: scout
      responsibility: Locate the API surface.
      task: Inspect the API for {{input.goal}}.
  parallel: true
```

```yaml
delegate:
  agents: [scout] # constrained dynamic fan-out
  minCalls: 1
  maxCalls: 4
  parallel: true
  guidance: Give each scout a distinct responsibility for {{input.goal}}.
```

Delegation constraints are prompt guidance by design: `pi-workflow` does not inspect or block `subagent` calls. When `pi-subagents` is loaded with its read-only `listAgents()` bridge, referenced agent names are validated against registered subagents.

### Templates

Templates are deliberately safe and non-executable. Only these forms are accepted:

- `{{input.goal}}`
- `{{artifacts.name}}` where `name` is a declared text artifact

No filters, code, environment access, shell expansion, or arbitrary expressions are supported.

## Runtime behavior

When `/workflow run` starts a workflow, the extension stores a pinned normalized snapshot and hash in Pi session custom entries via `pi.appendEntry()`. State is restored from `ctx.sessionManager.getBranch()`, making it branch-correct.

For each running step, `before_agent_start` appends a compact protocol to the system prompt containing:

- workflow ownership of the session,
- goal, run id, pinned hash, current step id/type,
- rendered current-step instructions only,
- referenced artifacts for that step only,
- allowed outcomes and required artifact outputs.

The internal `workflow_checkpoint` tool is registered but is kept active only while a run is `running`. It validates stale step ids, allowed outcomes, declared text artifacts, required step outputs, and transition targets. If the next step is `end`, the run is completed and the tool is disabled; otherwise the tool returns the next-step continuation protocol.
