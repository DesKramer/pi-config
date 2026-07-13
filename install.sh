#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$REPO_DIR/scripts/apply-config.mjs"

cat <<MSG

Config applied.

To load this repo's extensions on this machine, run one of:
  pi install "$REPO_DIR"
  pi install git:git@github.com:YOUR_GITHUB_USER/pi-config

Then restart pi, or run /reload inside pi.
MSG
