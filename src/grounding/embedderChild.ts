/**
 * Embedding worker — runs the native onnxruntime model OUTSIDE the Electron main
 * process (loading it in main SIGTRAPs). Two host shapes, one worker:
 *  - PACKAGED: Electron `utilityProcess.fork` runs this; it talks over
 *    `process.parentPort` (postMessage). utilityProcess is the supported way to
 *    run a native-addon Node child of a packaged Electron app — a raw
 *    spawn(execPath, {ELECTRON_RUN_AS_NODE}) sets the child up poorly and the
 *    native runtime crashes under a real GUI launch.
 *  - DEV: spawned via tsx as a plain Node process; it talks newline-JSON over
 *    stdio (no parentPort there).
 *
 * Protocol (either transport): parent → {id, texts}; child → {id, vectors} or
 * {id, error}; child announces {ready:true} once. The model loads lazily on the
 * first embed.
 */
import { TransformersEmbedder } from "./embedderTransformers.js";

interface Request {
  id: number;
  texts: string[];
}

const embedder = new TransformersEmbedder();

/** Run one request → its reply frame. Never throws (errors become {error}). */
async function run(req: Request): Promise<Record<string, unknown>> {
  try {
    return { id: req.id, vectors: await embedder.embed(req.texts) };
  } catch (err) {
    return { id: req.id, error: err instanceof Error ? err.message : String(err) };
  }
}

// utilityProcess exposes process.parentPort; a plain-Node (dev tsx) run does not.
const parentPort = (
  process as unknown as {
    parentPort?: {
      on(ev: "message", cb: (e: { data: Request }) => void): void;
      postMessage(msg: unknown): void;
    };
  }
).parentPort;

if (parentPort) {
  // PACKAGED: Electron utilityProcess transport.
  parentPort.on("message", (e) => {
    void run(e.data).then((reply) => parentPort.postMessage(reply));
  });
  parentPort.postMessage({ ready: true });
} else {
  // DEV: newline-JSON over stdio. Keep stdout pristine for the protocol; route
  // any library console chatter (transformers prints progress) to stderr.
  const writeFrame = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]): void => console.error(...args);
  const send = (msg: Record<string, unknown>): void => {
    writeFrame(JSON.stringify(msg) + "\n");
  };
  let buffer = "";
  process.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim().length === 0) continue;
      let req: Request;
      try {
        req = JSON.parse(line) as Request;
      } catch {
        continue;
      }
      void run(req).then(send);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  send({ ready: true });
}
