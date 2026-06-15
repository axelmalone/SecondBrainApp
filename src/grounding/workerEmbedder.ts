import * as os from "node:os";
import type { Embedder } from "./types.js";

/**
 * Shared lifecycle for an embedder that runs the model in a CHILD worker (so the
 * native/WASM ONNX runtime never touches the Electron main process). Subclasses
 * supply only the transport: how to spawn one worker and talk to it. Everything
 * else — lazy spawn, the request/reply id map, low OS priority, idle-reaping of
 * the memory-heavy child, crash-rejects-then-respawns — lives here, once.
 *
 * Pure Node (no electron, no child_process) so the lifecycle is unit-testable
 * with a fake transport. ChildProcessEmbedder backs it with stdio; the packaged
 * UtilityProcessEmbedder backs it with an Electron utilityProcess.
 */
export interface WorkerReply {
  ready?: boolean;
  id?: number;
  vectors?: number[][];
  error?: string;
}

/** The base wires these into the worker the transport spawns. */
export interface WorkerHandlers {
  /** The worker announced it's ready (pipe wired; model loads lazily). */
  onReady(): void;
  /** A non-ready reply frame: {id, vectors} or {id, error}. */
  onReply(reply: WorkerReply): void;
  /** The worker exited/crashed. */
  onExit(): void;
  /** A transport-level error (spawn/pipe). Treated like an exit. */
  onError(err: Error): void;
}

/** One live worker the base talks to. */
export interface WorkerConnection {
  send(msg: { id: number; texts: string[] }): void;
  kill(): void;
  /** OS pid, when known, so the base can lower its priority. */
  pid?: number | undefined;
}

export interface WorkerEmbedderOptions {
  dimension: number;
  /** OS nice value (0..19; higher = lower priority). Default 10. 0 disables. */
  niceness?: number | undefined;
  /** Reap the model-loaded child after this many ms idle (respawns lazily).
   *  0 disables. Default 30s. */
  idleMs?: number | undefined;
}

interface Pending {
  resolve: (vectors: number[][]) => void;
  reject: (err: Error) => void;
}

export abstract class WorkerEmbedder implements Embedder {
  readonly dimension: number;
  private readonly niceness: number;
  private readonly idleMs: number;
  private conn: WorkerConnection | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WorkerEmbedderOptions) {
    this.dimension = opts.dimension;
    this.niceness = opts.niceness ?? 10;
    this.idleMs = opts.idleMs ?? 30_000;
  }

  /**
   * Spawn ONE worker, wiring its events to `handlers`, and return a connection.
   * May throw synchronously on spawn failure (the base catches it); report a
   * later transport error via `handlers.onError`.
   */
  protected abstract createConnection(handlers: WorkerHandlers): WorkerConnection;

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.clearIdle(); // work starting — don't reap the child under us
    await this.ensureChild();
    const conn = this.conn;
    if (!conn) throw new Error("embedder worker is not running");
    const id = this.nextId++;
    try {
      return await new Promise<number[][]>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        try {
          conn.send({ id, texts });
        } catch (err) {
          // Channel closed in the gap after readiness — reject this just-
          // registered request so the caller never hangs.
          this.pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    } finally {
      this.armIdle(); // idle again → eligible for reaping after idleMs
    }
  }

  /** Stop the worker (e.g. on vault switch). Safe to call when not running. */
  dispose(): void {
    this.clearIdle();
    this.rejectAll(new Error("embedder disposed"));
    this.conn?.kill();
    this.conn = null;
    this.ready = null;
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private armIdle(): void {
    if (this.idleMs <= 0) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size > 0) {
        this.armIdle();
        return;
      }
      this.conn?.kill();
      this.conn = null;
      this.ready = null;
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private ensureChild(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let conn: WorkerConnection;
      const handlers: WorkerHandlers = {
        onReady: () => resolve(),
        onReply: (reply) => {
          if (this.conn !== conn) return; // ignore a stale/replaced worker's frames
          if (typeof reply.id !== "number") return;
          const p = this.pending.get(reply.id);
          if (!p) return;
          this.pending.delete(reply.id);
          if (reply.error !== undefined) p.reject(new Error(reply.error));
          else p.resolve(reply.vectors ?? []);
        },
        onExit: () => {
          if (this.conn !== conn) return; // a late exit from a replaced worker
          this.handleExit();
          reject(new Error("embedder worker exited before ready")); // no-op if resolved
        },
        onError: (err) => {
          if (this.conn !== conn) return;
          this.handleExit();
          reject(err); // no-op if already resolved
        },
      };
      try {
        conn = this.createConnection(handlers);
      } catch (err) {
        this.ready = null;
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.conn = conn;

      // Lower OS priority so a busy index yields to the user's foreground work.
      if (typeof conn.pid === "number" && this.niceness > 0) {
        try {
          os.setPriority(conn.pid, this.niceness);
        } catch {
          /* best effort — not fatal if the platform refuses */
        }
      }
    });
    return this.ready;
  }

  private handleExit(): void {
    this.conn = null;
    this.ready = null;
    this.rejectAll(new Error("embedder worker exited"));
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
