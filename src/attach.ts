/**
 * Interactive terminal attach — bridges stdin/stdout to a daemon session.
 *
 * - Puts the local terminal in raw mode
 * - Writes the session snapshot to stdout (screen restore)
 * - Forwards stdin → daemon write, daemon data → stdout
 * - Handles SIGWINCH for resize
 * - Escape sequence (~.) to detach (like SSH)
 */

import type { DaemonClient, CreateOrAttachResponse } from "./client.js";

const ESCAPE_CHAR = 0x1e; // Ctrl+^ (RS) — detach hotkey, avoids collision with Ctrl+C etc.

export async function attachSession(
  client: DaemonClient,
  sessionId: string,
  attachResp: CreateOrAttachResponse,
): Promise<void> {
  const { snapshot } = attachResp;

  // Restore terminal state from snapshot
  if (snapshot.snapshotAnsi) {
    process.stdout.write(snapshot.snapshotAnsi);
  }
  if (snapshot.rehydrateSequences) {
    process.stdout.write(snapshot.rehydrateSequences);
  }

  // Put local terminal in raw mode
  if (!process.stdin.isTTY) {
    console.error("stdin is not a TTY, attach requires an interactive terminal");
    process.exit(1);
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let detached = false;

  const cleanup = () => {
    if (detached) return;
    detached = true;
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.removeAllListeners("data");
    process.removeListener("SIGWINCH", onResize);
    // Reset terminal
    process.stdout.write("\r\n");
  };

  // Forward daemon output → stdout
  const onData = (_sid: string, data: string) => {
    if (_sid === sessionId) {
      process.stdout.write(data);
    }
  };
  client.on("data", onData);

  // Handle session exit
  const onExit = (_sid: string, code: number) => {
    if (_sid === sessionId) {
      cleanup();
      console.log(`\r\nSession exited (code ${code})`);
      client.destroy();
      process.exit(code);
    }
  };
  client.on("exit", onExit);

  // Handle disconnect
  client.on("disconnect", () => {
    cleanup();
    console.log("\r\nDaemon connection lost");
    process.exit(1);
  });

  // Forward stdin → daemon write
  let prevByte = 0;
  process.stdin.on("data", (chunk: Buffer) => {
    if (detached) return;

    // Check for detach sequence: Ctrl+^ then 'q'
    for (const byte of chunk) {
      if (prevByte === ESCAPE_CHAR && byte === 0x71 /* 'q' */) {
        cleanup();
        console.log("Detached (session still running)");
        client.destroy();
        process.exit(0);
        return;
      }
      prevByte = byte;
    }

    client.write(sessionId, chunk.toString());
  });

  // Resize forwarding
  const onResize = () => {
    if (detached) return;
    const { columns, rows } = process.stdout;
    if (columns && rows) {
      client.resize(sessionId, columns, rows);
    }
  };
  process.on("SIGWINCH", onResize);

  // Send initial resize to match local terminal
  onResize();

  // Print attach banner
  const cwd = snapshot.cwd ?? "?";
  process.stderr.write(
    `\x1b[90m[attached to ${sessionId} | cwd: ${cwd} | Ctrl+^ then q to detach]\x1b[0m\r\n`,
  );

  // Keep process alive
  await new Promise<void>(() => {});
}
