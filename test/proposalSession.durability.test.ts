import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProposalStore } from "../src/main/proposalStore.js";
import { ProposalSession } from "../src/main/proposalSession.js";

const TSX = path.join(process.cwd(), "node_modules", ".bin", "tsx");
const APPLIER = path.join(process.cwd(), "scripts", "kill9-applier.ts");

function spawnAndKill(args: string[], delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [APPLIER, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timer: NodeJS.Timeout | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("applying") && timer === undefined) {
        timer = setTimeout(() => child.kill("SIGKILL"), delayMs);
      }
    });
    const done = (): void => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.on("exit", done);
    child.on("error", done);
  });
}

/** Count non-overlapping occurrences of `needle` in `hay`. */
function count(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

describe("proposal apply durability (kill -9 mid-apply, 7A)", () => {
  it(
    "never double-appends and never leaves a proposal stuck applying",
    async () => {
      const FRAGMENT = "- AI APPENDED LINE";
      const BODY = "# Log\n";
      let landed = 0;
      const delays = [0, 0, 0, 1, 1, 2, 3, 5, 10, 25, 60, 200];

      for (const delayMs of delays) {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sb-apply-k9-"));
        try {
          const vault = path.join(tmp, "vault");
          const storeDir = path.join(tmp, "store");
          await fs.mkdir(vault, { recursive: true });
          const notePath = path.join(vault, "log.md");
          await fs.writeFile(notePath, BODY, "utf8");

          const store = new ProposalStore(storeDir);
          const session = new ProposalSession({ store, getRoot: () => vault });
          const p = await session.create(
            { kind: "append", targetPath: "log.md", content: FRAGMENT },
            { chatId: "c", turnTs: 1 }
          );

          await spawnAndKill([storeDir, vault, p!.id], delayMs);
          // A real restart happens AFTER the crashed process is fully gone — let
          // the filesystem settle so the test models a sequential restart, not a
          // read racing the dying child's last in-flight write.
          await new Promise((r) => setTimeout(r, 120));

          // Restart: a fresh session recovers any interrupted apply.
          const store2 = new ProposalStore(storeDir);
          const recovSession = new ProposalSession({ store: store2, getRoot: () => vault });
          await recovSession.recoverOnLaunch();

          const finalNote = await fs.readFile(notePath, "utf8");
          // The fragment is present at most once — NEVER double-appended.
          expect(count(finalNote, FRAGMENT)).toBeLessThanOrEqual(1);
          // The note is whole: either untouched or appended exactly once.
          expect([BODY, BODY + FRAGMENT + "\n"]).toContain(finalNote);

          // No proposal is left stuck in applying after recovery.
          const stuck = await store2.recoverInFlight();
          expect(stuck).toHaveLength(0);

          if (count(finalNote, FRAGMENT) === 1) landed++;
        } finally {
          await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      }

      // Prove the harness exercised a real apply at least once.
      expect(landed).toBeGreaterThan(0);
    },
    120_000
  );
});
