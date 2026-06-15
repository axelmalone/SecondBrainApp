import type { Embedder } from "./types.js";

// all-MiniLM-L6-v2 produces 384-dim sentence embeddings.
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DIMENSION = 384;

/**
 * Texts per ONNX inference call. This is the INFERENCE batch, independent of the
 * grounding layer's EMBED_BATCH (which controls progress granularity / how many
 * chunks are handed to embed() at once). One inference call becomes a single
 * padded tensor; under the WASM backend a large batch overruns memory and
 * OrtRun throws (error 6), so we cap each call here and the indexer's larger
 * batch is re-sliced transparently. Keep small for WASM safety.
 */
const INFERENCE_BATCH = 8;

// Minimal shape of the bits of transformers.js we touch. The package is ESM and
// heavy; we load it lazily via a non-literal dynamic import so the CommonJS main
// build never has to statically resolve its ESM types, and so the ~90MB model
// only downloads when the user actually turns grounding on.
interface FeatureTensor {
  tolist(): number[][];
}
type Extractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean }
) => Promise<FeatureTensor>;
/** The subset of transformers.js `env` we configure to bundle the model. */
interface TransformersEnv {
  localModelPath: string;
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
}
interface TransformersModule {
  pipeline(task: "feature-extraction", model: string): Promise<Extractor>;
  env: TransformersEnv;
}

// @xenova/transformers is ESM-only. Under the CommonJS main build, TypeScript
// would downlevel a literal `import()` to `require()`, which throws
// ERR_REQUIRE_ESM at runtime. Routing through Function keeps a REAL dynamic
// import() in the emitted JS — Node supports importing ESM from CJS that way.
const dynamicImport = new Function(
  "specifier",
  "return import(specifier);"
) as (specifier: string) => Promise<unknown>;

/**
 * The production local embedder (D9). Runs all-MiniLM-L6-v2 fully on-device via
 * transformers.js (ONNX). First use downloads the model weights once; every run
 * after that is offline — no note text ever leaves the machine.
 */
export class TransformersEmbedder implements Embedder {
  readonly dimension = DIMENSION;
  private extractor: Promise<Extractor> | null = null;

  private load(): Promise<Extractor> {
    if (!this.extractor) {
      this.extractor = (
        dynamicImport("@xenova/transformers") as Promise<TransformersModule>
      ).then((mod) => {
        // Packaged build (D17): SB_MODEL_PATH points at the model bundled in app
        // resources. Pin transformers to it and forbid remote fetches, so the
        // first index works fully offline and nothing is downloaded. In dev the
        // var is unset → default behavior (download once to the HF cache).
        const local = process.env.SB_MODEL_PATH;
        if (local) {
          mod.env.localModelPath = local;
          mod.env.allowLocalModels = true;
          mod.env.allowRemoteModels = false;
        }
        return mod.pipeline("feature-extraction", MODEL_ID);
      });
    }
    return this.extractor;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    if (texts.length <= INFERENCE_BATCH) {
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      return output.tolist();
    }
    // Re-slice to INFERENCE_BATCH-sized runs (WASM memory safety). Order is
    // preserved: results are pushed in input order.
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += INFERENCE_BATCH) {
      const slice = texts.slice(i, i + INFERENCE_BATCH);
      const output = await extractor(slice, { pooling: "mean", normalize: true });
      out.push(...output.tolist());
    }
    return out;
  }
}
