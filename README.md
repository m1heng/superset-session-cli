# superset-session-cli

CLI to list and attach to [Superset](https://github.com/superset-sh/superset) terminal sessions — locally or on a remote machine via SSH.

## Why

Superset's terminal sessions are managed by a persistent daemon that survives app restarts. This CLI connects directly to that daemon, letting you:

- **SSH into a remote Mac** running Superset and attach to any active terminal session
- **Monitor what's running** across all your Superset workspaces from the command line
- **Multi-client attach** — connect alongside the Superset UI without disrupting it

## Install

### npx / bunx (requires Bun)

```bash
bunx superset-session-cli list
bunx superset-session-cli attach <session-id>
```

### Standalone binary (no dependencies)

Download from [GitHub Releases](https://github.com/m1heng/superset-session-cli/releases/latest):

| Platform | Binary |
|---|---|
| macOS Apple Silicon | `superset-session-darwin-arm64` |
| macOS Intel | `superset-session-darwin-x64` |

```bash
# Example: Apple Silicon Mac
curl -L -o superset-session \
  https://github.com/m1heng/superset-session-cli/releases/latest/download/superset-session-darwin-arm64
chmod +x superset-session
./superset-session list
```

### From source

```bash
git clone https://github.com/m1heng/superset-session-cli.git
cd superset-session-cli
bun install
bun run src/cli.ts list
```

## Usage

```bash
# List all sessions on local machine
superset-session list

# Attach to a session
superset-session attach <session-id>

# List sessions on remote machine (via SSH)
superset-session list --host user@remote-mac

# Attach to a remote session
superset-session attach <session-id> --host user@remote-mac
```

### List output

```
● project-name / workspace-name (branch)
  id: pane-1774531944081-1sowc2e8m  pid: 8789  clients: 0
  ~/.superset/worktrees/project/branch-name

○ project-name / another-workspace (main)
  id: pane-1774065779184-ddq9mjpv4  pid: -  clients: 0
  ~/github/org/repo
```

- `●` green = session alive
- `○` gray = session exited (daemon still holds the record)

### Detach

Press `Ctrl+^` then `q` to detach. The session keeps running.

## How it works

Superset runs a **terminal host daemon** as a background process (`~/.superset/terminal-host.sock`). Each terminal pane in the UI is a PTY session managed by this daemon. Sessions persist even when the app restarts.

This CLI speaks the daemon's NDJSON protocol directly:

```
CLI → Unix socket → Daemon → PTY sessions
         ↑
    (or SSH tunnel for remote)
```

For remote access, an SSH ControlMaster connection is established once (enter password once), then all subsequent operations (token fetch, DB copy, socket tunnel) reuse it.

## Requirements

- **Superset Desktop** must be running on the target machine (local or remote)
- **Bun** to build from source (standalone binary needs nothing)
- **SSH access** for remote mode
