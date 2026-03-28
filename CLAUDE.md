# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

CLI tool that connects to the [Superset](https://github.com/superset-sh/superset) desktop app's terminal host daemon. Lists active terminal sessions and attaches to them interactively — locally or on a remote machine via SSH.

## Commands

```bash
bun run src/cli.ts list                          # list local sessions
bun run src/cli.ts attach <id>                   # attach to a session
bun run src/cli.ts list --host user@host         # list remote sessions via SSH
bun run src/cli.ts attach <id> --host user@host  # attach to remote session

bun build src/cli.ts --compile --outfile superset-session  # standalone binary (no Bun needed on target)
```

## Architecture

Three files, one concern each:

- **`src/cli.ts`** — Entry point, arg parsing, SSH plumbing, workspace metadata lookup
- **`src/client.ts`** — `DaemonClient` class: NDJSON-over-Unix-socket protocol client for the Superset terminal host daemon
- **`src/attach.ts`** — Interactive attach: raw mode stdin/stdout bridge, snapshot restore, resize forwarding, detach hotkey

### Daemon Protocol

The Superset terminal host daemon runs at `~/.superset/terminal-host.sock` with token auth from `~/.superset/terminal-host.token`. Protocol is NDJSON (newline-delimited JSON) with dual sockets per client:

- **Control socket** — RPC (request/response): `hello`, `listSessions`, `createOrAttach`, `write`, `resize`, `signal`, `kill`, `detach`
- **Stream socket** — Events (daemon → client): `data`, `exit`, `error`, each tagged with `sessionId`

Protocol version is 2. Both sockets authenticate via `hello` with the same `clientId` but different `role`.

### SSH Remote Mode

Uses SSH ControlMaster so password is entered once. Flow:
1. `startSshMaster()` — establishes master connection (inherits stdin for password)
2. `getRemoteInfo()` — single SSH exec to get home dir + token
3. `startSshTunnel()` + `fetchRemoteDb()` — run in parallel, reuse master
4. Connect to daemon through tunneled Unix socket

### Workspace Metadata

`list` reads `~/.superset/local.db` (SQLite, Drizzle ORM schema) to resolve `workspaceId` → project name, workspace name, branch, and worktree path. Falls back gracefully if DB is unavailable.

## Key Constraints

- **Bun-only**: Uses `bun:sqlite` for workspace metadata. Won't run on plain Node.
- **Unix socket path limit**: ~104 chars. SSH control and tunnel socket paths use `/tmp/st-*` prefix to stay short.
- **Detach hotkey**: `Ctrl+^` then `q` (0x1e + 0x71). Chosen to avoid collision with Ctrl+C, Ctrl+D, etc.
