/**
 * Superset Terminal Host Daemon Client
 *
 * Connects to the daemon via Unix socket (NDJSON protocol).
 * Supports both local socket and SSH-tunneled connections.
 */

import net from "node:net";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

const PROTOCOL_VERSION = 2;

// ---------------------------------------------------------------------------
// Types (mirrored from Superset's types.ts — kept minimal)
// ---------------------------------------------------------------------------

export interface SessionInfo {
  sessionId: string;
  workspaceId: string;
  paneId: string;
  isAlive: boolean;
  attachedClients: number;
  pid: number | null;
  createdAt?: string;
  lastAttachedAt?: string;
  shell?: string;
}

export interface TerminalSnapshot {
  snapshotAnsi: string;
  rehydrateSequences: string;
  cwd: string | null;
  cols: number;
  rows: number;
  scrollbackLines: number;
}

export interface CreateOrAttachResponse {
  isNew: boolean;
  snapshot: TerminalSnapshot;
  wasRecovered: boolean;
  pid: number | null;
}

// ---------------------------------------------------------------------------
// NDJSON helpers
// ---------------------------------------------------------------------------

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
};

function parseNdjsonLines(
  buffer: string,
  onMessage: (msg: unknown) => void,
): string {
  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (line.length > 0) {
      try {
        onMessage(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class DaemonClient extends EventEmitter {
  private controlSocket: net.Socket | null = null;
  private streamSocket: net.Socket | null = null;
  private controlBuffer = "";
  private streamBuffer = "";
  private pending = new Map<string, PendingRequest>();
  private clientId = randomUUID();
  private reqCounter = 0;

  constructor(
    private socketPath: string,
    private token: string,
  ) {
    super();
  }

  // -- Connection -----------------------------------------------------------

  async connect(): Promise<void> {
    // Connect control socket first, then stream socket
    this.controlSocket = await this.connectSocket("control");
    this.streamSocket = await this.connectSocket("stream");
  }

  private connectSocket(
    role: "control" | "stream",
  ): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath, async () => {
        try {
          // Set up data handler before hello
          if (role === "control") {
            sock.on("data", (chunk) => {
              this.controlBuffer = parseNdjsonLines(
                this.controlBuffer + chunk.toString(),
                (msg) => this.handleControlMessage(msg),
              );
            });
          } else {
            sock.on("data", (chunk) => {
              this.streamBuffer = parseNdjsonLines(
                this.streamBuffer + chunk.toString(),
                (msg) => this.handleStreamMessage(msg),
              );
            });
          }

          // Send hello handshake
          await this.sendHello(sock, role);
          resolve(sock);
        } catch (err) {
          reject(err);
        }
      });

      sock.on("error", (err) => {
        if (role === "control") {
          this.emit("error", err);
        }
        reject(err);
      });

      sock.on("close", () => {
        if (role === "stream") {
          this.emit("disconnect");
        }
      });
    });
  }

  private sendHello(
    sock: net.Socket,
    role: "control" | "stream",
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = this.nextId();
      const msg = JSON.stringify({
        id,
        type: "hello",
        payload: {
          token: this.token,
          protocolVersion: PROTOCOL_VERSION,
          clientId: this.clientId,
          role,
        },
      });

      // Temporarily intercept the response for this specific hello
      const onData = (chunk: Buffer) => {
        const line = chunk.toString().trim();
        try {
          const resp = JSON.parse(line);
          if (resp.id === id) {
            sock.off("data", onData);
            if (resp.ok) {
              resolve();
            } else {
              reject(
                new Error(
                  `Hello failed (${role}): ${resp.error?.message ?? "unknown"}`,
                ),
              );
            }
          }
        } catch {
          // not our message yet
        }
      };
      sock.on("data", onData);
      sock.write(msg + "\n");
    });
  }

  // -- RPC ------------------------------------------------------------------

  private nextId(): string {
    return `req_${++this.reqCounter}`;
  }

  private request<T = unknown>(type: string, payload?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.controlSocket) {
        return reject(new Error("Not connected"));
      }
      const id = this.nextId();
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      const msg = JSON.stringify({ id, type, payload });
      this.controlSocket.write(msg + "\n");
    });
  }

  private handleControlMessage(msg: unknown): void {
    const m = msg as { id?: string; ok?: boolean; payload?: unknown; error?: { message: string } };
    if (!m.id) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.ok) {
      p.resolve(m.payload);
    } else {
      p.reject(new Error(m.error?.message ?? "Unknown daemon error"));
    }
  }

  private handleStreamMessage(msg: unknown): void {
    const m = msg as {
      type?: string;
      event?: string;
      sessionId?: string;
      payload?: { type?: string; data?: string; exitCode?: number };
    };
    if (m.type !== "event" || !m.sessionId || !m.payload) return;

    switch (m.event) {
      case "data":
        this.emit("data", m.sessionId, m.payload.data);
        break;
      case "exit":
        this.emit("exit", m.sessionId, m.payload.exitCode);
        break;
      case "error":
        this.emit("session-error", m.sessionId, m.payload);
        break;
    }
  }

  // -- Public API -----------------------------------------------------------

  async listSessions(): Promise<SessionInfo[]> {
    const resp = await this.request<{ sessions: SessionInfo[] }>(
      "listSessions",
    );
    return resp.sessions;
  }

  async createOrAttach(params: {
    sessionId: string;
    workspaceId: string;
    paneId: string;
    tabId: string;
    cols: number;
    rows: number;
    cwd?: string;
  }): Promise<CreateOrAttachResponse> {
    return this.request<CreateOrAttachResponse>("createOrAttach", params);
  }

  write(sessionId: string, data: string): void {
    if (!this.controlSocket) return;
    const id = this.nextId();
    const msg = JSON.stringify({
      id,
      type: "write",
      payload: { sessionId, data },
    });
    this.controlSocket.write(msg + "\n");
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (!this.controlSocket) return;
    const id = this.nextId();
    const msg = JSON.stringify({
      id,
      type: "resize",
      payload: { sessionId, cols, rows },
    });
    this.controlSocket.write(msg + "\n");
  }

  async detach(sessionId: string): Promise<void> {
    await this.request("detach", { sessionId });
  }

  async signal(sessionId: string, signal = "SIGINT"): Promise<void> {
    await this.request("signal", { sessionId, signal });
  }

  destroy(): void {
    this.controlSocket?.destroy();
    this.streamSocket?.destroy();
    this.controlSocket = null;
    this.streamSocket = null;
  }
}
