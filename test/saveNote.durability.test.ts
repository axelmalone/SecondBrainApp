import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { makeTempVault, writeNote, cleanup } from "./helpers.js";

let vault: string;
afterEach(async () => {
  if (vault) await cleanup(vault);
});

const TSX = path.join(process.cwd(), "node_modules", ".bin", "tsx");
const WRITER = path.join(process.cwd(), "scripts", "kill9-writer.ts");

/**
 * Spawn the writer child and SIGKILL it `delayMs` AFTER it signals (via its
 * "writing" stdout line) that it has entered the atomic write. Killing relative
 * to that signal — not to spawn time — guarantees the kill lands during/after
 * the real write rather than during tsx/node startup, so the test exercises the
 * actual rename window. Resolves once the child exits, however it exits.
 */
function spawnAndKill(
  target: string,
  contentPath: string,
  delayMs: number
): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [WRITER, target, contentPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timer: NodeJS.Timeout | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("writing") && timer === undefined) {
        timer = setTimeout(() => child.kill("SIGKILL"), delayMs);
      }
    });
    const done = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.on("exit", done);
    child.on("error", done);
  });
}

describe("saveNote durability (kill -9 mid-write)", () => {
  it(
    "original file is always whole — never partial — across many killed writes",
    async () => {
      vault = await makeTempVault();
      const OLD = "ORIGINAL CONTENT — must never be left partial\n";
      const target = await writeNote(vault, "durable.md", OLD);

      // Large new payload so the temp-write phase is wide enough to interrupt.
      const NEW = "X".repeat(2_000_000) + "\nNEW-END\n";
      const contentPath = path.join(vault, ".new-content");
      await fs.writeFile(contentPath, NEW, "utf8");

      const outcomes = { old: 0, new: 0 };
      // Delays spread across the write: 0ms tries to catch mid-temp-write;
      // larger delays let the rename complete (the NEW outcome).
      const delays = [0, 0, 0, 1, 1, 2, 3, 5, 10, 25, 50, 200];

      for (const delayMs of delays) {
        // Reset the target to the known-good OLD content before each attempt.
        await fs.writeFile(target, OLD, "utf8");

        await spawnAndKill(target, contentPath, delayMs);

        const after = await fs.readFile(target, "utf8");
        // The atomic invariant: reader sees OLD or NEW in full, never partial.
        expect([OLD, NEW]).toContain(after);
        if (after === OLD) outcomes.old++;
        else outcomes.new++;

        // A killed write must never leave a temp orphan that survives as the note.
        const entries = await fs.readdir(vault);
        expect(entries.includes("durable.md")).toBe(true);
      }

      // Prove the harness actually exercised the write path end-to-end: at
      // least one kill let the rename complete (NEW). Otherwise a silently
      // broken child would make every assertion pass trivially on OLD.
      expect(outcomes.new).toBeGreaterThan(0);
    },
    120_000
  );
});
