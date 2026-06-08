import type { Embedder } from "./types.js";
import { ChildProcessEmbedder, type ChildEmbedderSpec } from "./childEmbedder.js";

/**
 * An Embedder backed by a POOL of N stock-Node child workers. A single worker
 * never saturates even one core (it idles between stdio round-trips and ONNX
 * doesn't spread one small batch across cores), so N independent worker
 * processes are how we actually use the machine — measured ~3.8x at N=4 vs a
 * single worker. embed() hands each batch to a free worker; the pool caps real
 * parallelism at N, so firing every batch at once (Promise.all in indexVault)
 * just keeps all N busy.
 *
 * Workers spawn lazily and idle-reap (see ChildEmbedderSpec.idleMs), so the wide
 * pool only holds memory during an actual index, not forever.
 */
export class PooledEmbedder implements Embedder {
  readonly dimension: number;
  private readonly workers: ChildProcessEmbedder[];
  private readonly idle: ChildProcessEmbedder[];
  private readonly waiters: ((w: ChildProcessEmbedder) => void)[] = [];

  constructor(spec: ChildEmbedderSpec, size: number) {
    this.dimension = spec.dimension;
    const n = Math.max(1, Math.floor(size));
    this.workers = Array.from({ length: n }, () => new ChildProcessEmbedder(spec));
    this.idle = [...this.workers];
  }

  get size(): number {
    return this.workers.length;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const worker = await this.acquire();
    try {
      return await worker.embed(texts);
    } finally {
      this.release(worker); // a crashed worker self-respawns on its next embed
    }
  }

  dispose(): void {
    for (const w of this.workers) w.dispose();
    this.idle.length = 0;
    this.waiters.length = 0;
  }

  private acquire(): Promise<ChildProcessEmbedder> {
    const free = this.idle.pop();
    if (free) return Promise.resolve(free);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(worker: ChildProcessEmbedder): void {
    const next = this.waiters.shift();
    if (next) next(worker);
    else this.idle.push(worker);
  }
}
