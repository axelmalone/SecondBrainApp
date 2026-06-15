import { spawn, type ChildProcessByStdio } from "node:child_process";
import * as os from "node:os";
import type { Readable, Writable } from "node:stream";
import type { Embedder } from "./types.js";

// stdio is ["pipe","pipe","inherit"]: piped stdin/stdout, inherited stderr (null).
type Worker = ChildProcessByStdio<Writable, Readable, null>;

export interface ChildEmbedderSpec {
  /** Executable to spawn (e.g. the tsx bin in dev, or the Electron binary run as
   *  Node in a packaged build). */
  command: string;
  /** Args (e.g. [path/to/embedderChild.ts] in dev, [.../embedderChild.js] packaged). */
  args: string[];
  /** Environment for the child. When omitted, the child inherits the parent's
   *  env (the dev default). A packaged build passes `ELECTRON_RUN_AS_NODE=1` (so
   *  the Electron binary behaves as stock Node) and the bundled model path. The
   *  caller MUST spread `process.env` in — this REPLACES the environment. */
  env?: NodeJS.ProcessEnv;
  /** Embedding dimensionality (must match the model). */
  dimension: number;
  /** OS nice value for the worker (0..19; higher = lower priority). Keeps a busy
   *  index from making the machine feel laggy — it yields to foreground work.
   *  Default 10. 0 disables. */
  niceness?: number;
  /** Kill the (memory-heavy ~400MB) child after this many ms idle; it respawns
   *  lazily on next embed. 0 disables. Default 30s. */
  idleMs?: number;
}

interface Pending {
  resolve: (vectors: number[][]) => void;
  reject: (err: Error) => void;
}

/**
 * Embedder that runs the real model in a STOCK-NODE child process (see
 * embedderChild.ts for why). The native ONNX runtime never touches the Electron
 * main process, so indexing can no longer SIGTRAP it. The child is spawned once
 * and kept alive (the ~90MB model loads a single time); a crash rejects in-flight
 * work and the next embed respawns cleanly — a failed embed degrades to a normal
 * "indexing failed" error, never a hard crash.
 *
 * Pure Node (child_process only) — the spawn spec is injected so this stays
 * Electron-free and unit-testable with a stub child.
 */
export class ChildProcessEmbedder implements Embedder {
  readonly dimension: number;
  private readonly spec: ChildEmbedderSpec;
  private readonly niceness: number;
  private readonly idleMs: number;
  private child: Worker | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private stdoutBuffer = "";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(spec: ChildEmbedderSpec) {
    this.spec = spec;
    this.dimension = spec.dimension;
    this.niceness = spec.niceness ?? 10;
    this.idleMs = spec.idleMs ?? 30_000;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.clearIdle(); // a request is starting; don't reap the child under us
    await this.ensureChild();
    const child = this.child;
    if (!child) throw new Error("embedder child is not running");

    const id = this.nextId++;
    const result = new Promise<number[][]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, texts }) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
    try {
      return await result;
    } finally {
      this.armIdle(); // idle again → eligible for reaping after idleMs
    }
  }

  /** Stop the child (e.g. on vault switch). Safe to call when not running. */
  dispose(): void {
    this.clearIdle();
    this.rejectAll(new Error("embedder disposed"));
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Reap the child after idleMs of no work (respawns lazily on next embed).
   *  unref'd so the timer never keeps the process alive on its own. */
  private armIdle(): void {
    if (this.idleMs <= 0) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size > 0) {
        this.armIdle();
        return;
      }
      this.child?.kill();
      this.child = null;
      this.ready = null;
      this.stdoutBuffer = "";
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private ensureChild(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let child: Worker;
      try {
        child = spawn(this.spec.command, this.spec.args, {
          stdio: ["pipe", "pipe", "inherit"], // stderr → our terminal for logs/progress
          // Omitted env → child inherits process.env (dev default). A packaged
          // build passes a full env (process.env + ELECTRON_RUN_AS_NODE + model path).
          ...(this.spec.env ? { env: this.spec.env } : {}),
        });
      } catch (err) {
        this.ready = null;
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.child = child;

      // Run the (CPU-heavy) model at low OS priority so a busy index yields to
      // the user's foreground work and never makes the machine feel laggy.
      if (typeof child.pid === "number" && this.niceness > 0) {
        try {
          os.setPriority(child.pid, this.niceness);
        } catch {
          /* best effort — not fatal if the platform refuses */
        }
      }

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.onStdout(chunk, resolve));
      child.on("error", (err) => {
        this.handleExit();
        reject(err); // no-op if `ready` already resolved
      });
      child.on("exit", () => {
        this.handleExit();
        // Surfaces an early exit to whoever is awaiting ensureChild(); a no-op
        // once `ready` has resolved (the crash already rejected pending work).
        reject(new Error("embedder child exited before ready"));
      });
    });
    return this.ready;
  }

  private onStdout(chunk: string, onReady: () => void): void {
    this.stdoutBuffer += chunk;
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (line.trim().length === 0) continue;
      let msg: { id?: number; vectors?: number[][]; error?: string; ready?: boolean };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-protocol noise that slipped onto stdout
      }
      if (msg.ready) {
        onReady();
        continue;
      }
      if (typeof msg.id !== "number") continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(msg.error));
      else p.resolve(msg.vectors ?? []);
    }
  }

  private handleExit(): void {
    this.child = null;
    this.ready = null;
    this.stdoutBuffer = "";
    this.rejectAll(new Error("embedder child exited"));
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
