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
| `skill-dollar.ts` | `$` skill invocation/autocomplete helper. |
| `tps-status.ts` | Tokens-per-second/status display. |
| `usage.ts` | Usage/cost/session utility display. |
| `zsh-user-bash.ts` | Runs user bash commands through zsh/local shell behavior. |

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
