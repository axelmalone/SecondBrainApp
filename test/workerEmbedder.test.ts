import { describe, it, expect, vi } from "vitest";
import {
  WorkerEmbedder,
  type WorkerConnection,
  type WorkerHandlers,
  type WorkerEmbedderOptions,
} from "../src/grounding/workerEmbedder.js";

/**
 * Drives WorkerEmbedder's lifecycle with a FAKE transport — no spawn, no
 * electron. Covers what both ChildProcessEmbedder and UtilityProcessEmbedder
 * share (id map, reuse, crash-reject-respawn, idle reaping, dispose, stale
 * guards) so the packaged-only utility embedder's logic is testable too.
 */
class FakeEmbedder extends WorkerEmbedder {
  spawns = 0;
  killed = 0;
  sent: { id: number; texts: string[] }[] = [];
  failNextSend = false;
  pid: number | undefined = 4242;
  private handlers: WorkerHandlers | null = null;

  constructor(opts: Partial<WorkerEmbedderOptions> = {}) {
    super({ dimension: 3, niceness: 10, idleMs: 0, ...opts });
  }

  protected createConnection(handlers: WorkerHandlers): WorkerConnection {
    this.spawns++;
    this.handlers = handlers;
    queueMicrotask(() => handlers.onReady()); // worker announces ready async
    return {
      send: (msg) => {
        if (this.failNextSend) {
          this.failNextSend = false;
          throw new Error("channel closed");
        }
        this.sent.push(msg);
      },
      kill: () => {
        this.killed++;
      },
      pid: this.pid,
    };
  }

  // Test drivers (act as the worker replying).
  reply(id: number, vectors: number[][]): void {
    this.handlers!.onReply({ id, vectors });
  }
  replyError(id: number, error: string): void {
    this.handlers!.onReply({ id, error });
  }
  crash(): void {
    this.handlers!.onExit();
  }
  lastHandlers(): WorkerHandlers {
    return this.handlers!;
  }
}

async function flushSend(fe: FakeEmbedder, n: number): Promise<void> {
  await vi.waitFor(() => expect(fe.sent.length).toBe(n));
}

describe("WorkerEmbedder lifecycle", () => {
  it("embeds: spawns once, matches reply by id, resolves vectors", async () => {
    const fe = new FakeEmbedder();
    const p = fe.embed(["a"]);
    await flushSend(fe, 1);
    fe.reply(fe.sent[0]!.id, [[1, 2, 3]]);
    expect(await p).toEqual([[1, 2, 3]]);
    expect(fe.spawns).toBe(1);
  });

  it("empty input short-circuits without spawning", async () => {
    const fe = new FakeEmbedder();
    expect(await fe.embed([])).toEqual([]);
    expect(fe.spawns).toBe(0);
  });

  it("reuses one worker across embeds and matches out-of-order replies", async () => {
    const fe = new FakeEmbedder();
    const p1 = fe.embed(["a"]);
    await flushSend(fe, 1);
    const p2 = fe.embed(["b"]);
    await flushSend(fe, 2);
    // reply in reverse order
    fe.reply(fe.sent[1]!.id, [[9]]);
    fe.reply(fe.sent[0]!.id, [[1]]);
    expect(await p1).toEqual([[1]]);
    expect(await p2).toEqual([[9]]);
    expect(fe.spawns).toBe(1); // one worker reused
  });

  it("propagates a worker-reported embed error", async () => {
    const fe = new FakeEmbedder();
    const p = fe.embed(["a"]);
    await flushSend(fe, 1);
    fe.replyError(fe.sent[0]!.id, "model blew up");
    await expect(p).rejects.toThrow("model blew up");
  });

  it("crash rejects in-flight work; next embed respawns", async () => {
    const fe = new FakeEmbedder();
    const p = fe.embed(["a"]);
    await flushSend(fe, 1);
    fe.crash();
    await expect(p).rejects.toThrow(/exited/);
    // a new embed spawns a fresh worker
    const p2 = fe.embed(["b"]);
    await flushSend(fe, 2);
    fe.reply(fe.sent[1]!.id, [[7]]);
    expect(await p2).toEqual([[7]]);
    expect(fe.spawns).toBe(2);
  });

  it("rejects a just-registered request if send throws (no hang)", async () => {
    const fe = new FakeEmbedder();
    // warm up one worker so ensureChild is resolved
    const warm = fe.embed(["x"]);
    await flushSend(fe, 1);
    fe.reply(fe.sent[0]!.id, [[0]]);
    await warm;
    // now the next send throws synchronously
    fe.failNextSend = true;
    await expect(fe.embed(["y"])).rejects.toThrow(/channel closed/);
  });

  it("dispose rejects pending and kills the worker", async () => {
    const fe = new FakeEmbedder();
    const p = fe.embed(["a"]);
    await flushSend(fe, 1);
    fe.dispose();
    await expect(p).rejects.toThrow(/disposed/);
    expect(fe.killed).toBe(1);
  });

  it("ignores a stale (replaced) worker's late exit/reply", async () => {
    const fe = new FakeEmbedder();
    const p1 = fe.embed(["a"]);
    await flushSend(fe, 1);
    const stale = fe.lastHandlers(); // worker #1's handlers
    fe.crash(); // worker #1 exits → p1 rejects, respawn on next embed
    await expect(p1).rejects.toThrow();
    const p2 = fe.embed(["b"]);
    await flushSend(fe, 2);
    // worker #1's late frames must NOT settle worker #2's request
    stale.onReply({ id: fe.sent[1]!.id, vectors: [[999]] });
    stale.onExit();
    // worker #2 still answers correctly
    fe.reply(fe.sent[1]!.id, [[2]]);
    expect(await p2).toEqual([[2]]);
  });

  it("reaps the idle worker after idleMs, respawning on next embed", async () => {
    const fe = new FakeEmbedder({ idleMs: 20 });
    const p = fe.embed(["a"]);
    await flushSend(fe, 1);
    fe.reply(fe.sent[0]!.id, [[1]]);
    await p;
    // wait past the idle window → child reaped (killed)
    await vi.waitFor(() => expect(fe.killed).toBe(1), { timeout: 500 });
    const p2 = fe.embed(["b"]);
    await flushSend(fe, 2);
    fe.reply(fe.sent[1]!.id, [[2]]);
    expect(await p2).toEqual([[2]]);
    expect(fe.spawns).toBe(2); // respawned after the reap
  });
});
