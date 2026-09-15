# deskramer-pi-config

Personal [Pi](https://pi.dev) package for portable extensions plus sanitized settings/custom provider templates.

## Install on another machine

Full setup, including settings/custom providers and extensions:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

git clone git@github.com:DesKramer/pi-config.git ~/pi-config
cd ~/pi-config

# Applies config/settings.json and config/models.json into ~/.pi/agent, with backups.
./install.sh

# Loads this repo's extensions as a Pi package.
pi install "$(pwd)"

# Authenticate subscription providers / OAuth providers as needed.
pi /login
```

Set machine-local provider secrets before using the custom providers:

```bash
export AZURE_FOUNDRY_TECH_API_KEY="..."
export COSINE_API_KEY="..."
```

Put those in your shell profile, a password-manager-backed shell hook, or another machine-local secret manager.

### Extensions-only install

If you only want the package resources without merging `settings.json` / `models.json` into `~/.pi/agent`:

```bash
pi install git:git@github.com:DesKramer/pi-config.git
```

This loads the extensions, including `extensions/custom-providers.ts`, which registers providers from the package's `config/models.json`.

## Included resources

### Extensions

| Extension | Purpose |
| --- | --- |
| `ask-user-tool.ts` | Adds an interactive ask-user style tool/UI flow. |
| `copy-agent-last.ts` | Helper for copying the latest assistant output. |
| `custom-providers.ts` | Registers custom providers from `config/models.json`. |
| `firecrawl-tools.ts` | Firecrawl search/scrape tools. |
| `fuzzy-file-autocomplete.ts` | Extends `@` file completion with one-edit typo tolerance using a bounded, ignore-aware `fd` index. |
| `git-status-widget.ts` | Git status widget/status display. |
| `orchestrator/` | Opt-in orchestration prompt layer with a live registry. Off by default; toggle with `/orchestrator`. |
| `pi-subagents/` | Subagent tooling with five bundled profiles (`orchestrator`, `qa`, `scout`, `web-researcher`, and `worker`), defaulting to `openai-codex/gpt-6-astra`, plus `safe-bash`. |
| `pi-workflow/` | YAML workflow runner with `/workflow` commands, checkpoint tool, and pinned branch-correct state. |
| `pretty-markdown-code.ts` | Improved markdown/code rendering. |
| `provider-model-picker.ts` | Provider/model picker helper. |
| `remote-pi/` | Attached-session Remote Pi bridge over strict LF JSONL Unix socket with fail-open reconnect, snapshots, events, commands, and explicit attached-only capabilities. |
| `retry.ts` | `/retry` resumes the last failed model request after automatic retries stop. |
| `skill-dollar.ts` | `$` skill invocation/autocomplete helper. |
| `tps-status.ts` | Tokens-per-second/status display. |
| `usage.ts` | Usage/cost/session utility display. |
| `zsh-user-bash.ts` | Runs user bash commands through zsh/local shell behavior. |

### Remote Pi attached-session bridge

The bridge connects to the daemon's owner-only Unix socket. Socket selection matches the daemon:

1. `REMOTE_PI_BRIDGE_SOCKET`, if set.
2. `bridge.sock` inside `REMOTE_PI_DATA_DIR`, if set.
3. On Linux, `$XDG_DATA_HOME/remote-pi/bridge.sock` when XDG_DATA_HOME is absolute; otherwise `~/.local/share/remote-pi/bridge.sock`.
4. On macOS, `~/Library/Application Support/remote-pi/bridge.sock`.

Export any overrides in the shell that starts Pi as well as in the daemon's environment. A service's environment does not automatically reach an existing terminal. Programmatic `socketPath` options take precedence over environment settings. `/remote-pi-status` reports the socket actually selected by the bridge.

After updating this local package, run `/reload` in each open Pi terminal, then `/remote-pi-status`. No daemon restart or phone re-pairing is needed for this path fix. The supported attached commands are prompt, steer, follow-up, and abort; managed-only capabilities remain unavailable on attached sessions.

To run the bridge tests, install dev dependencies with `npm ci`, then run `node --experimental-strip-types --test tests/remote-pi.test.ts`. Fixture decoding expects the `remote-pi` repository checked out beside `pi-config`.

### Retrying after a network failure

Once Pi stops with an error such as `fetch failed`, wait for your connection to recover and run:

```text
/retry
```

The command starts another model call using the current session context and selected model. It keeps your original prompt, images, and completed tool results, without rewinding the conversation or resubmitting the prompt. It stores a hidden control message that the extension removes from model context along with the failed partial responses.

`/retry` refuses to run while Pi is busy or has queued messages. It only retries a model error at the end of the active branch, not a successful response, a tool error, or an Escape cancellation. Pi's normal automatic retry settings still apply. If the connection fails again, you can run `/retry` again after Pi stops. It also works after reloading or resuming a failed session.

After updating an installed local package, run `/reload` to load the command. To try just this extension from this checkout:

```bash
pi -e ./extensions/retry.ts
```

### Custom providers

Defined in `config/models.json` and registered by `extensions/custom-providers.ts`:

- `azure-foundry-tech`
- `cosine`
- `ollama`

Remote provider API keys are stored as environment references, not committed raw secrets:

- `AZURE_FOUNDRY_TECH_API_KEY`
- `COSINE_API_KEY`

The `ollama` provider uses the local API at `http://localhost:11434/v1` with the required dummy key `ollama`. Its configured local models are `ornith-1.5:9b` and `granite4.2:3b`.

### Settings

Portable settings currently managed in `config/settings.json`:

| Setting | Value |
| --- | --- |
| `theme` | `dark` |
| `defaultProvider` | `cosine` |
| `defaultModel` | `glm-5.2` |
| `defaultThinkingLevel` | `high` |
| `packages` | `npm:pi-web-access`, `npm:pi-mcp-adapter` |

`./install.sh` merges these settings into `~/.pi/agent/settings.json`. Package entries are additive, and existing machine-local `skills`, `extensions`, `prompts`, and `themes` are preserved unless explicitly added to `config/settings.json`.

### Workflows

Two `pi-workflow` definitions are included:

- `workflows/feature-implementation.workflow.yaml`
- `workflows/bug-fixing.workflow.yaml`

The bug-fixing workflow analyzes the report, scouts the likely source, asks for expected behavior only when missing, scouts related implementation areas, and delegates the fix to a worker.

To make the workflows discoverable, copy them to `~/.pi/agent/workflows/` or to a trusted project's `.pi/workflows/` directory:

```bash
mkdir -p ~/.pi/agent/workflows
cp workflows/*.workflow.yaml ~/.pi/agent/workflows/
```

### Prompts

No prompt templates are currently included.

### Themes

No custom themes are currently included.

### Skills

[`implementation-plan`](skills/implementation-plan/SKILL.md) works with the user to write a codebase-grounded plan for another coding agent. It covers the full requested change, design decisions, blast radius, implementation steps, and acceptance checks. It does not implement the change or turn the request into a phased rollout.

This skill requires explicit user invocation. Its `disable-model-invocation: true` setting excludes it from the model's available-skills prompt.

```text
/skill:implementation-plan <your change request>
```

With the included `skill-dollar.ts` extension, you can also use `$implementation-plan <your change request>`.

The package loads this skill alongside its extensions. After updating an installed local package, run `/reload` or restart Pi. Other machine-specific skills remain outside this repo.

## What is intentionally not included

- `auth.json`
- OAuth/MCP tokens
- sessions
- trust decisions
- npm/git package install caches
- machine-specific skills such as `~/.cosine/skills`
- raw API keys

## Updating this repo

After changing extensions or config:

```bash
cd ~/pi-config # or /Users/deskramer/Documents/Code/pi-config on the source machine
git add .
git commit -m "Update pi config"
git push
```

On another machine using the cloned/local package workflow:

```bash
cd ~/pi-config
git pull
./install.sh
pi update --extensions
```

If installed directly via `pi install git:...`:

```bash
pi update --extensions
```

## Notes

Custom providers are available two ways:

1. The package extension `extensions/custom-providers.ts` registers them from `config/models.json`.
2. `./install.sh` also merges them into `~/.pi/agent/models.json` as a fallback for non-package use.
