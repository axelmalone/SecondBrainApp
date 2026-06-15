// Build-time model fetch (D17). Downloads the local embedding model once into
// `resources/models/` so electron-builder can bundle it (extraResources) and the
// packaged app indexes fully offline — no surprise HuggingFace CDN call on first
// use, which would be off-brand for a "nothing leaves your machine" tool.
//
// Not committed to git (resources/models is gitignored — ~90MB); run as part of
// `npm run package` before electron-builder. Idempotent: transformers.js skips
// files already present in the cache dir.
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dest = path.join(here, "..", "resources", "models");

const { env, pipeline } = await import("@xenova/transformers");
// cacheDir lays files out as <owner>/<model>/… — the same shape localModelPath
// reads at runtime, so the packaged app can point straight at this directory.
env.cacheDir = dest;
env.allowRemoteModels = true;
env.allowLocalModels = true;

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
console.log(`Fetching ${MODEL_ID} → ${dest} …`);
const extractor = await pipeline("feature-extraction", MODEL_ID);
// One real run so every file the model needs (weights + tokenizer + config) is
// pulled, not just the manifest.
await extractor(["warm up"], { pooling: "mean", normalize: true });
console.log("Model fetched and ready to bundle.");
