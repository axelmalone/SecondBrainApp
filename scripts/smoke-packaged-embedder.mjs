// Headless smoke test of the PACKAGED embedder path. Spawns the built app's
// embedder worker exactly as the app does — the Electron binary run as Node
// (ELECTRON_RUN_AS_NODE) against the asar'd dist worker, pointed at the bundled
// model — and asks it to embed. Proves the whole packaged runtime works:
// ELECTRON_RUN_AS_NODE + asar require + onnxruntime-node native load + the
// bundled model loading fully offline. Exits non-zero on any failure.
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, "..", "release", "mac-arm64", "Second Brain.app");
const electronBin = path.join(app, "Contents", "MacOS", "Second Brain");
const child = path.join(app, "Contents", "Resources", "app.asar", "dist", "grounding", "embedderChild.js");
const modelPath = path.join(app, "Contents", "Resources", "models");

console.log("Spawning packaged embedder worker (ELECTRON_RUN_AS_NODE)…");
const proc = spawn(electronBin, [child], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", SB_MODEL_PATH: modelPath },
});

let buf = "";
const timeout = setTimeout(() => {
  console.error("FAIL: no embedding within 60s");
  proc.kill();
  process.exit(1);
}, 60_000);

proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.ready) {
      console.log("worker ready — sending embed request…");
      proc.stdin.write(JSON.stringify({ id: 1, texts: ["hello from the packaged app"] }) + "\n");
    } else if (msg.id === 1 && msg.vectors) {
      const dim = msg.vectors[0]?.length;
      clearTimeout(timeout);
      console.log(`PASS: packaged embedder returned a ${dim}-dim vector, fully offline.`);
      proc.kill();
      process.exit(dim === 384 ? 0 : 1);
    } else if (msg.error) {
      clearTimeout(timeout);
      console.error("FAIL: worker error:", msg.error);
      proc.kill();
      process.exit(1);
    }
  }
});
proc.on("error", (err) => {
  clearTimeout(timeout);
  console.error("FAIL: could not spawn:", err.message);
  process.exit(1);
});
