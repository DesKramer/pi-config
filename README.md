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
| `ephemeral.ts` | Ephemeral/session helper extension. |
| `firecrawl-tools.ts` | Firecrawl search/scrape tools. |
| `git-status-widget.ts` | Git status widget/status display. |
| `pi-subagents/` | Subagent tooling with `scout`, `researcher`, and `worker` agents plus `safe-bash`. |
| `pretty-markdown-code.ts` | Improved markdown/code rendering. |
| `provider-model-picker.ts` | Provider/model picker helper. |
| `skill-dollar.ts` | `$` skill invocation/autocomplete helper. |
| `tps-status.ts` | Tokens-per-second/status display. |
| `usage.ts` | Usage/cost/session utility display. |
| `zsh-user-bash.ts` | Runs user bash commands through zsh/local shell behavior. |

### Custom providers

Defined in `config/models.json` and registered by `extensions/custom-providers.ts`:

- `azure-foundry-tech`
- `cosine`

API keys are stored as environment references, not committed raw secrets:

- `AZURE_FOUNDRY_TECH_API_KEY`
- `COSINE_API_KEY`

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

### Prompts

No prompt templates are currently included.

### Themes

No custom themes are currently included.

### Skills

No skills are currently included. Skills are intentionally machine-specific for this setup.

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
