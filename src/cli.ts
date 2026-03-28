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
import { DaemonClient } from "./client.js";
import { attachSession } from "./attach.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPERSET_DIR = path.join(os.homedir(), ".superset");
const SOCKET_PATH = path.join(SUPERSET_DIR, "terminal-host.sock");
const TOKEN_PATH = path.join(SUPERSET_DIR, "terminal-host.token");

// ---------------------------------------------------------------------------
// SSH tunnel helper
// ---------------------------------------------------------------------------

function startSshTunnel(
  host: string,
  localSocket: string,
): { proc: ChildProcess; socketPath: string } {
  const remoteSocket = `~/.superset/terminal-host.sock`;
  // Use SSH local Unix socket forwarding: -L local:remote
  const proc = spawn(
    "ssh",
    [
      "-N", // no remote command
      "-L",
      `${localSocket}:${remoteSocket}`,
      host,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  proc.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg) console.error(`[ssh] ${msg}`);
  });

  return { proc, socketPath: localSocket };
}

async function getRemoteToken(host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ssh", [host, "cat", "~/.superset/terminal-host.token"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Failed to read remote token (ssh exit ${code})`));
      }
    });
  });
}

function waitForSocket(socketPath: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (fs.existsSync(socketPath)) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`SSH tunnel socket not ready after ${timeoutMs}ms`));
      }
      setTimeout(check, 200);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdList(client: DaemonClient): Promise<void> {
  const sessions = await client.listSessions();
  if (sessions.length === 0) {
    console.log("No active sessions.");
    return;
  }

  console.log(
    `${"SESSION ID".padEnd(40)} ${"WORKSPACE".padEnd(20)} ${"SHELL".padEnd(8)} ${"PID".padEnd(8)} ${"ALIVE".padEnd(6)} CLIENTS`,
  );
  console.log("-".repeat(100));

  for (const s of sessions) {
    console.log(
      `${s.sessionId.padEnd(40)} ${s.workspaceId.slice(0, 18).padEnd(20)} ${(s.shell ?? "?").padEnd(8)} ${String(s.pid ?? "-").padEnd(8)} ${(s.isAlive ? "yes" : "no").padEnd(6)} ${s.attachedClients}`,
    );
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
  let token: string;
  let sshProc: ChildProcess | undefined;

  if (remoteHost) {
    // Remote mode: SSH tunnel + fetch token
    console.error(`Connecting to ${remoteHost}...`);
    token = await getRemoteToken(remoteHost);

    const tmpSocket = path.join(
      os.tmpdir(),
      `superset-term-${process.pid}.sock`,
    );
    // Clean up stale socket
    if (fs.existsSync(tmpSocket)) fs.unlinkSync(tmpSocket);

    const tunnel = startSshTunnel(remoteHost, tmpSocket);
    sshProc = tunnel.proc;
    socketPath = tunnel.socketPath;

    // Wait for tunnel to be ready
    await waitForSocket(socketPath);
    console.error("SSH tunnel established.");
  } else {
    // Local mode
    if (!fs.existsSync(SOCKET_PATH)) {
      console.error(
        "Daemon socket not found. Is Superset running?",
      );
      process.exit(1);
    }
    token = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
  }

  const client = new DaemonClient(socketPath, token);

  // Cleanup on exit
  const cleanupAll = () => {
    client.destroy();
    sshProc?.kill();
    if (remoteHost && fs.existsSync(socketPath)) {
      try { fs.unlinkSync(socketPath); } catch {}
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
      await cmdList(client);
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
