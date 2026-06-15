import { utilityProcess, type UtilityProcess } from "electron";
import {
  WorkerEmbedder,
  type WorkerConnection,
  type WorkerHandlers,
  type WorkerReply,
} from "../grounding/workerEmbedder.js";

/**
 * Embedder backed by an Electron `utilityProcess` — the supported way to run a
 * native-addon Node child of a PACKAGED Electron app. A raw
 * `spawn(process.execPath, {ELECTRON_RUN_AS_NODE})` child sets up its runtime
 * poorly and onnxruntime crashes (SIGTRAP) under a real GUI launch; utilityProcess
 * forks a properly-initialised Node process where it loads fine.
 *
 * Supplies only the utilityProcess transport; the lifecycle (id map, idle
 * reaping, low priority, crash-rejects-then-respawns) lives in WorkerEmbedder.
 */
export interface UtilityEmbedderSpec {
  /** Absolute path to the compiled worker (dist/grounding/embedderChild.js). */
  modulePath: string;
  /** Child environment (minimal + SB_MODEL_PATH / WASM vars). */
  env: Record<string, string>;
  /** Embedding dimensionality (must match the model). */
  dimension: number;
  /** OS nice value (0..19; higher = lower priority). Default 10. */
  niceness?: number;
  /** Reap the model-loaded child after this many ms idle. Default 30s. */
  idleMs?: number;
}

export class UtilityProcessEmbedder extends WorkerEmbedder {
  private readonly spec: UtilityEmbedderSpec;

  constructor(spec: UtilityEmbedderSpec) {
    super({ dimension: spec.dimension, niceness: spec.niceness, idleMs: spec.idleMs });
    this.spec = spec;
  }

  protected createConnection(handlers: WorkerHandlers): WorkerConnection {
    const child: UtilityProcess = utilityProcess.fork(this.spec.modulePath, [], {
      env: this.spec.env,
      // No piped stdio: the worker reports over the message channel, and a GUI
      // app has nowhere useful to inherit stdio to.
      stdio: "ignore",
      serviceName: "second-brain-embedder",
    });

    child.on("message", (msg: WorkerReply) => {
      if (msg?.ready) handlers.onReady();
      else handlers.onReply(msg);
    });
    child.on("exit", () => handlers.onExit());

    return {
      send: (msg) => child.postMessage(msg),
      kill: () => {
        child.kill();
      },
      pid: child.pid,
    };
  }
}
