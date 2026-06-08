import type { Embedder } from "./types.js";

// all-MiniLM-L6-v2 produces 384-dim sentence embeddings.
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DIMENSION = 384;

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
interface TransformersModule {
  pipeline(task: "feature-extraction", model: string): Promise<Extractor>;
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
      ).then((mod) => mod.pipeline("feature-extraction", MODEL_ID));
    }
    return this.extractor;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.load();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist();
  }
}
