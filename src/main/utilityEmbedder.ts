import { utilityProcess, type UtilityProcess } from "electron";
import type { Embedder } from "../grounding/types.js";

/**
 * Embedder backed by an Electron `utilityProcess` (the supported way to run a
 * native-addon Node child of a PACKAGED Electron app). A raw
 * `spawn(process.execPath, {ELECTRON_RUN_AS_NODE})` child sets up its runtime
 * poorly and the native onnxruntime crashes (SIGTRAP) under a real GUI launch;
 * utilityProcess forks a properly-initialised Node process where it loads fine.
 *
 * Same request/reply contract as ChildProcessEmbedder, but over the utility
 * process message channel instead of stdio. The ~90MB model loads lazily in the
 * child on the first embed; a crash rejects in-flight work and the next embed
 * respawns, degrading to a normal "indexing failed", never a hard crash.
 */
interface Pending {
  resolve: (vectors: number[][]) => void;
  reject: (err: Error) => void;
}

export interface UtilityEmbedderSpec {
  /** Absolute path to the compiled worker (dist/grounding/embedderChild.js). */
  modulePath: string;
  /** Child environment (minimal + SB_MODEL_PATH). */
  env: Record<string, string>;
  /** Embedding dimensionality (must match the model). */
  dimension: number;
}

export class UtilityProcessEmbedder implements Embedder {
  readonly dimension: number;
  private child: UtilityProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;

  constructor(private readonly spec: UtilityEmbedderSpec) {
    this.dimension = spec.dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.ensureChild();
    const child = this.child;
    if (!child) throw new Error("embedder utility process is not running");
    const id = this.nextId++;
    return new Promise<number[][]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.postMessage({ id, texts });
    });
  }

  /** Stop the child (e.g. on vault switch). Safe to call when not running. */
  dispose(): void {
    this.rejectAll(new Error("embedder disposed"));
    this.child?.kill();
    this.child = null;
    this.ready = null;
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

      child.on(
        "message",
        (msg: { ready?: boolean; id?: number; vectors?: number[][]; error?: string }) => {
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
        this.handleExit();
        reject(new Error("embedder child exited before ready")); // no-op if already resolved
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
