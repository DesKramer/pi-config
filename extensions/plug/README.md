# PLUG integration

This Pi extension exposes the local [PLUG](../../../plug) broker through four shell-free tools:

- `plug_list` — discover installed plugins and tool contracts;
- `plug_run` — pass an explicit argv array to an installed plugin;
- `plug_auth_status` — inspect one plugin's connection state;
- `plug_reauth` — explicitly begin reauthentication (never called by diagnostics);
- `/plug-status` — non-mutating `plug`/`plugd` executable, socket, broker, and per-plugin auth diagnostics.

Every tool invokes `plug --json` directly with `spawn(..., { shell: false })`, forwards Pi's abort signal, enforces a timeout and a combined output limit, and returns the complete PLUG JSON envelope. Oversized output is rejected rather than returning partial/invalid JSON. Errors are bounded, control-character stripped, and redact common bearer/query-secret forms.

## Local setup

Requirements: Go 1.25+, Node.js 24+, and `~/.local/bin` on `PATH`.

```sh
mkdir -p "$HOME/.local/bin" "$HOME/.plug"
cd /Users/deskramer/Documents/Code/plug
go test ./...
go build -o "$HOME/.local/bin/plug" ./cmd/plug
go build -o "$HOME/.local/bin/plugd" ./cmd/plugd
chmod 0755 "$HOME/.local/bin/plug" "$HOME/.local/bin/plugd"
```

On first start, `plugd` naturally creates PLUG's default empty active registry. Do not overwrite or replace an existing registry. Start one broker with logs kept outside Pi's context:

```sh
nohup "$HOME/.local/bin/plugd" --dev \
  >"$HOME/.plug/plugd.log" 2>&1 </dev/null &
```

Verify without installing plugins or authenticating:

```sh
"$HOME/.local/bin/plug" --json list
pi install /Users/deskramer/Documents/Code/pi-config
pi list
```

The list probe should be valid JSON with `"ok": true`. In Pi, run `/plug-status`; an empty registry reports a ready broker with zero plugins and performs no auth or reauth calls.

## Configuration

- `PLUG_BIN`: absolute path to `plug` (otherwise `~/.local/bin/plug`, then `PATH`, is searched).
- `PLUGD_BIN`: absolute path to `plugd` (otherwise `~/.local/bin/plugd`, then `PATH`, is searched).
- `PLUG_SOCKET`: broker socket override (otherwise PLUG's normal XDG or `~/.plug/plug.sock` default).

`plug_run.arguments` are never interpolated into a command string. Provide every option/value as its own array item. PLUG itself owns registry policy, credentials, redaction, provider output limits, and broker activity logs. This extension never reads credentials or the private socket protocol.
