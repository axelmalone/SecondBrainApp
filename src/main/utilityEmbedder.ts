import * as os from "node:os";
import { utilityProcess, type UtilityProcess } from "electron";
import type { Embedder } from "../grounding/types.js";

/**
 * Embedder backed by an Electron `utilityProcess` (the supported way to run a
 * native-addon Node child of a PACKAGED Electron app). A raw
 * `spawn(process.execPath, {ELECTRON_RUN_AS_NODE})` child sets up its runtime
 * poorly and the native onnxruntime crashes (SIGTRAP) under a real GUI launch;
 * utilityProcess forks a properly-initialised Node process where it loads fine.
 *
 * Same request/reply contract + low-priority/idle-reaping lifecycle as
 * ChildProcessEmbedder, but over the utility process message channel instead of
 * stdio. The ~90MB model loads lazily in the child on the first embed; a crash
 * rejects in-flight work and the next embed respawns, degrading to a normal
 * "indexing failed", never a hard crash.
 */
interface Pending {
  resolve: (vectors: number[][]) => void;
  reject: (err: Error) => void;
}

export interface UtilityEmbedderSpec {
  /** Absolute path to the compiled worker (dist/grounding/embedderChild.js). */
  modulePath: string;
  /** Child environment (minimal + SB_MODEL_PATH / WASM vars). */
  env: Record<string, string>;
  /** Embedding dimensionality (must match the model). */
  dimension: number;
  /** OS nice value for the worker (0..19; higher = lower priority). Keeps a busy
   *  index from making the machine feel laggy — it yields to foreground work.
   *  Default 10. 0 disables. */
  niceness?: number;
  /** Kill the (memory-heavy, model-loaded) child after this many ms idle; it
   *  respawns lazily on next embed. 0 disables. Default 30s. */
  idleMs?: number;
}

export class UtilityProcessEmbedder implements Embedder {
  readonly dimension: number;
  private readonly niceness: number;
  private readonly idleMs: number;
  private child: UtilityProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly spec: UtilityEmbedderSpec) {
    this.dimension = spec.dimension;
    this.niceness = spec.niceness ?? 10;
    this.idleMs = spec.idleMs ?? 30_000;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.clearIdle(); // work starting — don't reap the child under us
    await this.ensureChild();
    const child = this.child;
    if (!child) throw new Error("embedder utility process is not running");
    const id = this.nextId++;
    try {
      return await new Promise<number[][]>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        try {
          child.postMessage({ id, texts });
        } catch (err) {
          // Channel closed in the gap after the readiness check (the exit
          // handler's rejectAll already ran while pending was empty) — reject
          // this just-registered request so the caller never hangs.
          this.pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
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

  /** Reap the memory-heavy (model-loaded) child after idleMs of no work; it
   *  respawns lazily on the next embed. unref'd so it never keeps the process up. */
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
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private ensureChild(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let child: UtilityProcess;
      try {
        child = utilityProcess.fork(this.spec.modulePath, [], {
          env: this.spec.env,
          // No piped stdio: the worker reports over the message channel, and a
          // GUI app has nowhere useful to inherit stdio to.
          stdio: "ignore",
          serviceName: "second-brain-embedder",
        });
      } catch (err) {
        this.ready = null;
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.child = child;

      // Run the CPU-heavy model at low OS priority so a busy index yields to the
      // user's foreground work. utilityProcess has no niceness option, so set it
      // on the pid after fork (best effort — not fatal if the platform refuses).
      if (typeof child.pid === "number" && this.niceness > 0) {
        try {
          os.setPriority(child.pid, this.niceness);
        } catch {
          /* best effort */
        }
      }

      child.on(
        "message",
        (msg: { ready?: boolean; id?: number; vectors?: number[][]; error?: string }) => {
          if (this.child !== child) return; // ignore a stale/replaced child's frames
          if (msg?.ready) {
            resolve();
            return;
          }
          if (typeof msg?.id !== "number") return;
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          if (msg.error !== undefined) p.reject(new Error(msg.error));
          else p.resolve(msg.vectors ?? []);
        }
      );
      child.on("exit", () => {
        // A late exit from a child we already replaced (reap/dispose) must not
        // tear down the CURRENT child or reject its in-flight work.
        if (this.child !== child) return;
        this.handleExit();
        reject(new Error("embedder child exited before ready")); // no-op if resolved
      });
    });
    return this.ready;
  }

  private handleExit(): void {
    this.child = null;
    this.ready = null;
    this.rejectAll(new Error("embedder child exited"));
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
