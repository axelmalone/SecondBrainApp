import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  WorkerEmbedder,
  type WorkerConnection,
  type WorkerHandlers,
  type WorkerReply,
} from "./workerEmbedder.js";

// stdio is ["pipe","pipe","inherit"]: piped stdin/stdout, inherited stderr (null).
type Worker = ChildProcessByStdio<Writable, Readable, null>;

export interface ChildEmbedderSpec {
  /** Executable to spawn (e.g. the tsx bin in dev, or the Electron binary run as
   *  Node in a packaged build). */
  command: string;
  /** Args (e.g. [path/to/embedderChild.ts] in dev, [.../embedderChild.js] packaged). */
  args: string[];
  /** Environment for the child. When omitted, the child inherits the parent's
   *  env (the dev default). The caller MUST spread `process.env` in — this
   *  REPLACES the environment. */
  env?: NodeJS.ProcessEnv;
  /** Embedding dimensionality (must match the model). */
  dimension: number;
  /** OS nice value for the worker (0..19; higher = lower priority). Default 10. */
  niceness?: number;
  /** Kill the (memory-heavy ~400MB) child after this many ms idle; it respawns
   *  lazily on next embed. 0 disables. Default 30s. */
  idleMs?: number;
}

/**
 * Embedder that runs the real model in a STOCK-NODE child process over stdio
 * (the dev path; see embedderChild.ts). The lifecycle (lazy spawn, id map, idle
 * reaping, crash-rejects-then-respawns, low priority) lives in WorkerEmbedder;
 * this class supplies only the stdio transport. The spawn spec is injected so it
 * stays Electron-free and unit-testable with a stub child.
 */
export class ChildProcessEmbedder extends WorkerEmbedder {
  private readonly spec: ChildEmbedderSpec;
  private stdoutBuffer = "";

  constructor(spec: ChildEmbedderSpec) {
    super({ dimension: spec.dimension, niceness: spec.niceness, idleMs: spec.idleMs });
    this.spec = spec;
  }

  protected createConnection(handlers: WorkerHandlers): WorkerConnection {
    this.stdoutBuffer = "";
    const child: Worker = spawn(this.spec.command, this.spec.args, {
      stdio: ["pipe", "pipe", "inherit"], // stderr → our terminal for logs/progress
      ...(this.spec.env ? { env: this.spec.env } : {}),
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk, handlers));
    child.on("error", (err) => handlers.onError(err));
    child.on("exit", () => handlers.onExit());

    return {
      send: (msg) => {
        child.stdin.write(JSON.stringify(msg) + "\n", (err) => {
          if (err) handlers.onError(err);
        });
      },
      kill: () => {
        child.kill();
      },
      pid: child.pid,
    };
  }

  /** Parse newline-delimited JSON protocol frames off stdout → handler calls. */
  private onStdout(chunk: string, handlers: WorkerHandlers): void {
    this.stdoutBuffer += chunk;
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (line.trim().length === 0) continue;
      let msg: WorkerReply;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-protocol noise that slipped onto stdout
      }
      if (msg.ready) handlers.onReady();
      else handlers.onReply(msg);
    }
  }
}
