#!/usr/bin/env bun
/**
 * superset-term — CLI to list and attach to Superset terminal daemon sessions.
 *
 * Usage:
 *   superset-term list                          # list sessions on local daemon
 *   superset-term attach <sessionId>            # attach to a local session
 *   superset-term list   --host office-mac      # list sessions on remote host (SSH)
 *   superset-term attach <sessionId> --host office-mac
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { Database } from "bun:sqlite";
import { DaemonClient, type SessionInfo } from "./client.js";
import { attachSession } from "./attach.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPERSET_DIR = path.join(os.homedir(), ".superset");
const SOCKET_PATH = path.join(SUPERSET_DIR, "terminal-host.sock");
const TOKEN_PATH = path.join(SUPERSET_DIR, "terminal-host.token");
const LOCAL_DB_PATH = path.join(SUPERSET_DIR, "local.db");

// ---------------------------------------------------------------------------
// SSH helpers — uses ControlMaster so password is only entered once
// ---------------------------------------------------------------------------

function sshControlPath(host: string): string {
  // Unix socket paths are limited to ~104 chars — keep it short
  const hash = Buffer.from(host).toString("base64url").slice(0, 8);
  return `/tmp/st-${hash}`;
}

/** Common SSH args that reuse the ControlMaster connection. */
function sshOpts(host: string): string[] {
  return [
    "-o", `ControlPath=${sshControlPath(host)}`,
    "-o", "ControlMaster=no",
  ];
}

/** Establish a ControlMaster SSH connection (inherits stdin for password). */
function startSshMaster(host: string): Promise<ChildProcess> {
  const ctlPath = sshControlPath(host);
  // Clean up stale socket
  if (fs.existsSync(ctlPath)) try { fs.unlinkSync(ctlPath); } catch {}

  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ssh",
      [
        "-o", `ControlPath=${ctlPath}`,
        "-o", "ControlMaster=yes",
        "-o", "ControlPersist=120",
        "-N", // no remote command
        host,
      ],
      { stdio: ["inherit", "ignore", "inherit"] }, // inherit stdin/stderr for password prompt
    );

    // Wait for the control socket to appear
    const start = Date.now();
    const check = () => {
      if (fs.existsSync(ctlPath)) return resolve(proc);
      if (Date.now() - start > 30000) {
        proc.kill();
        return reject(new Error("SSH master connection timed out"));
      }
      setTimeout(check, 200);
    };
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0 && !fs.existsSync(ctlPath)) {
        reject(new Error(`SSH connection failed (exit ${code})`));
      }
    });
    setTimeout(check, 300);
  });
}

/** Run a command on the remote host via the master connection. */
function sshExec(host: string, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ssh", [...sshOpts(host), host, cmd], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c: Buffer) => { stdout += c; });
    proc.stderr?.on("data", (c: Buffer) => { stderr += c; });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`ssh command failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

/** Fetch remote home dir, token, and paths in one SSH call. */
async function getRemoteInfo(host: string): Promise<{
  token: string;
  remoteSocket: string;
  remoteDbPath: string;
}> {
  const raw = await sshExec(
    host,
    'echo "$HOME" && cat "$HOME/.superset/terminal-host.token"',
  );
  const lines = raw.split("\n");
  const home = lines[0];
  const token = lines[1];
  if (!home || !token) throw new Error("Could not read remote home or token");
  return {
    token,
    remoteSocket: `${home}/.superset/terminal-host.sock`,
    remoteDbPath: `${home}/.superset/local.db`,
  };
}

function startSshTunnel(
  host: string,
  localSocket: string,
  remoteSocket: string,
): ChildProcess {
  const proc = spawn(
    "ssh",
    [...sshOpts(host), "-N", "-L", `${localSocket}:${remoteSocket}`, host],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  proc.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg) console.error(`[ssh] ${msg}`);
  });
  return proc;
}

function waitForSocket(socketPath: string, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (fs.existsSync(socketPath)) return resolve();
      if (Date.now() - start > timeoutMs)
        return reject(new Error(`SSH tunnel socket not ready after ${timeoutMs}ms`));
      setTimeout(check, 200);
    };
    check();
  });
}

/** Copy remote local.db via scp for workspace metadata lookup. */
async function fetchRemoteDb(host: string, remoteDbPath: string): Promise<string> {
  const localCopy = path.join(os.tmpdir(), `superset-term-${process.pid}.db`);
  return new Promise((resolve) => {
    const proc = spawn(
      "scp",
      ["-q", "-o", `ControlPath=${sshControlPath(host)}`, `${host}:${remoteDbPath}`, localCopy],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    proc.on("close", (code) => {
      resolve(code === 0 ? localCopy : "");
    });
  });
}

/** Tear down the ControlMaster. */
function stopSshMaster(host: string): void {
  const ctlPath = sshControlPath(host);
  try {
    spawn("ssh", ["-o", `ControlPath=${ctlPath}`, "-O", "exit", host], {
      stdio: "ignore",
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Workspace metadata from local DB
// ---------------------------------------------------------------------------

interface WorkspaceMeta {
  project: string;
  workspace: string;
  branch: string;
  path: string;
}

function loadWorkspaceMeta(dbPath: string): Map<string, WorkspaceMeta> {
  const map = new Map<string, WorkspaceMeta>();
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.query(`
      SELECT w.id, p.name AS project, w.name AS workspace, w.branch,
             COALESCE(wt.path, p.main_repo_path) AS path
      FROM workspaces w
      LEFT JOIN worktrees wt ON w.worktree_id = wt.id
      JOIN projects p ON w.project_id = p.id
    `).all() as Array<{ id: string; project: string; workspace: string; branch: string; path: string }>;
    for (const r of rows) {
      map.set(r.id, { project: r.project, workspace: r.workspace, branch: r.branch, path: r.path });
    }
    db.close();
  } catch {
    // DB not available (e.g. remote mode) — gracefully degrade
  }
  return map;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdList(client: DaemonClient, dbPath: string): Promise<void> {
  const sessions = await client.listSessions();
  if (sessions.length === 0) {
    console.log("No active sessions.");
    return;
  }

  const meta = loadWorkspaceMeta(dbPath);

  for (const s of sessions) {
    const m = meta.get(s.workspaceId);
    const alive = s.isAlive ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
    const label = m
      ? `\x1b[1m${m.project}\x1b[0m / ${m.workspace} \x1b[90m(${m.branch})\x1b[0m`
      : `\x1b[90m${s.workspaceId}\x1b[0m`;
    const dir = m?.path
      ? `\x1b[90m${m.path.replace(os.homedir(), "~")}\x1b[0m`
      : "";

    console.log(`${alive} ${label}`);
    console.log(`  id: ${s.sessionId}  pid: ${s.pid ?? "-"}  clients: ${s.attachedClients}`);
    if (dir) console.log(`  ${dir}`);
    console.log();
  }
}

async function cmdAttach(
  client: DaemonClient,
  sessionId: string,
): Promise<void> {
  // First list sessions to validate and get metadata
  const sessions = await client.listSessions();
  const target = sessions.find((s) => s.sessionId === sessionId);

  if (!target) {
    // Try prefix match
    const matches = sessions.filter((s) => s.sessionId.startsWith(sessionId));
    if (matches.length === 1) {
      sessionId = matches[0].sessionId;
    } else if (matches.length > 1) {
      console.error(
        `Ambiguous session ID "${sessionId}", matches: ${matches.map((s) => s.sessionId).join(", ")}`,
      );
      process.exit(1);
    } else {
      console.error(`Session "${sessionId}" not found.`);
      process.exit(1);
    }
  }

  const { columns: cols, rows } = process.stdout;

  const resp = await client.createOrAttach({
    sessionId,
    workspaceId: target?.workspaceId ?? sessionId,
    paneId: sessionId,
    tabId: `cli-${sessionId}`,
    cols: cols ?? 80,
    rows: rows ?? 24,
  });

  await attachSession(client, sessionId, resp);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.find((a) => !a.startsWith("-"));
  const hostFlag = args.indexOf("--host");
  const remoteHost = hostFlag !== -1 ? args[hostFlag + 1] : undefined;

  if (!command || command === "help" || args.includes("--help")) {
    console.log(`superset-term — connect to Superset terminal daemon sessions

Usage:
  superset-term list   [--host <ssh-host>]    List active sessions
  superset-term attach <id> [--host <ssh-host>]  Attach to a session

Options:
  --host <ssh-host>   Connect to remote daemon via SSH tunnel

Detach: Ctrl+^ then q (session keeps running)
`);
    process.exit(0);
  }

  let socketPath = SOCKET_PATH;
  let dbPath = LOCAL_DB_PATH;
  let token: string;
  let sshProc: ChildProcess | undefined;
  const tmpFiles: string[] = [];

  if (remoteHost) {
    console.error(`Connecting to ${remoteHost}...`);

    // 1. Establish master connection (only password prompt happens here)
    sshProc = await startSshMaster(remoteHost);
    console.error("SSH connected.");

    // 2. All subsequent SSH ops reuse the master — no more password prompts
    const remote = await getRemoteInfo(remoteHost);
    token = remote.token;

    const tmpSocket = `/tmp/st-tun-${process.pid}.sock`;
    if (fs.existsSync(tmpSocket)) fs.unlinkSync(tmpSocket);
    tmpFiles.push(tmpSocket);

    // Start tunnel + fetch DB in parallel (both reuse master)
    const tunnelProc = startSshTunnel(remoteHost, tmpSocket, remote.remoteSocket);
    const dbCopyPromise = fetchRemoteDb(remoteHost, remote.remoteDbPath);

    socketPath = tmpSocket;
    await waitForSocket(socketPath);
    console.error("SSH tunnel established.");

    const dbCopy = await dbCopyPromise;
    if (dbCopy) {
      dbPath = dbCopy;
      tmpFiles.push(dbCopy);
    }
  } else {
    if (!fs.existsSync(SOCKET_PATH)) {
      console.error("Daemon socket not found. Is Superset running?");
      process.exit(1);
    }
    token = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
  }

  const client = new DaemonClient(socketPath, token);

  // Cleanup on exit
  const cleanupAll = () => {
    client.destroy();
    if (remoteHost) stopSshMaster(remoteHost);
    sshProc?.kill();
    for (const f of tmpFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
  };
  process.on("exit", cleanupAll);
  process.on("SIGINT", () => { cleanupAll(); process.exit(130); });
  process.on("SIGTERM", () => { cleanupAll(); process.exit(143); });

  try {
    await client.connect();
  } catch (err) {
    console.error(`Failed to connect: ${(err as Error).message}`);
    cleanupAll();
    process.exit(1);
  }

  const sessionArg = args.find(
    (a) => a !== command && !a.startsWith("-") && a !== remoteHost,
  );

  switch (command) {
    case "list":
    case "ls":
      await cmdList(client, dbPath);
      cleanupAll();
      break;

    case "attach":
    case "a":
      if (!sessionArg) {
        console.error("Usage: superset-term attach <session-id>");
        cleanupAll();
        process.exit(1);
      }
      await cmdAttach(client, sessionArg);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      cleanupAll();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
