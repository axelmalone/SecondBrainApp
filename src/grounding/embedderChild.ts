/**
 * Embedding worker — runs in a STOCK Node child process (spawned via tsx), NOT
 * the Electron main process. onnxruntime-node is a native addon tested against
 * stock Node; loading it in Electron's main process SIGTRAPs. Isolating it here
 * keeps the native runtime in the environment it's built for.
 *
 * Protocol: newline-delimited JSON over stdio.
 *   parent → child:  {"id":N,"texts":[...]}
 *   child  → parent: {"id":N,"vectors":[[...],...]}  | {"id":N,"error":"..."}
 *   child announces readiness once with: {"ready":true}
 * stdout carries ONLY protocol frames; all human/library logging goes to stderr.
 *
 * NOTE (eventual packaged-build fix): this spawns the .ts source via tsx, which
 * only exists in dev. A packaged app needs a different path — bundle the model +
 * onnxruntime and fork compiled JS (or use an Electron utilityProcess). Tracked
 * as the D17 packaging task.
 */
import { TransformersEmbedder } from "./embedderTransformers.js";

// Keep stdout pristine for the protocol: route any library console.* chatter
// (transformers prints download progress) to stderr.
const writeFrame = process.stdout.write.bind(process.stdout);
console.log = (...args: unknown[]): void => console.error(...args);

interface Request {
  id: number;
  texts: string[];
}

const embedder = new TransformersEmbedder();

function send(msg: Record<string, unknown>): void {
  writeFrame(JSON.stringify(msg) + "\n");
}

async function handle(line: string): Promise<void> {
  let req: Request;
  try {
    req = JSON.parse(line) as Request;
  } catch {
    return; // ignore a malformed/torn line
  }
  try {
    const vectors = await embedder.embed(req.texts);
    send({ id: req.id, vectors });
  } catch (err) {
    send({ id: req.id, error: err instanceof Error ? err.message : String(err) });
  }
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim().length > 0) void handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));

// Announce readiness so the host knows the pipe is wired (the model still loads
// lazily on the first embed).
send({ ready: true });
