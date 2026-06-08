/**
 * Child process for the proposals.jsonl compaction durability simulation (1A).
 *
 * Usage: tsx scripts/kill9-compactor.ts <storeDir>
 *
 * The store dir is pre-seeded by the parent with a proposals.jsonl containing a
 * mix of RESOLVED (applied/rejected) and ACTIVE (pending) proposals. This child
 * runs compactOnLaunch — which archives resolved events then atomically rewrites
 * the active log — and signals "compacting" just before, so the parent can
 * SIGKILL mid-compaction. The invariant under test: no matter when the kill
 * lands, every proposal survives in (archive ⊎ active) and the active log still
 * folds without corruption.
 */
import { ProposalStore } from "../src/main/proposalStore.js";

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write("usage: kill9-compactor <storeDir>\n");
    process.exit(2);
  }
  const store = new ProposalStore(dir);
  process.stdout.write("compacting\n");
  await store.compactOnLaunch();
  process.stdout.write("done\n");
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
