/**
 * Child process for the kill-9 durability simulation.
 *
 * Usage: tsx scripts/kill9-writer.ts <targetPath> <newContentPath>
 *
 * Reads the current target to capture a baseline, then atomically writes the
 * new content over it using the SAME atomicWrite the app uses. The parent test
 * sends SIGKILL at an unpredictable moment. The invariant under test: no matter
 * when the kill lands, the target file is afterwards EITHER the original bytes
 * (kill before the rename) OR the full new bytes (kill after the rename) —
 * never a partial/corrupt file.
 */
import { promises as fs } from "node:fs";
import { atomicWrite } from "../src/vault/atomicWrite.js";
import { readWithBaseline } from "../src/vault/hash.js";

async function main(): Promise<void> {
  const target = process.argv[2];
  const contentPath = process.argv[3];
  if (!target || !contentPath) {
    process.stderr.write("usage: kill9-writer <targetPath> <newContentPath>\n");
    process.exit(2);
  }

  const { baseline } = await readWithBaseline(target);
  const content = await fs.readFile(contentPath, "utf8");

  // Signal the parent we are about to enter the write so it can time the kill.
  process.stdout.write("writing\n");

  await atomicWrite(target, content, { baseline, backup: true });

  process.stdout.write("done\n");
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
