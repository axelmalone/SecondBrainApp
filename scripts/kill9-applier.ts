/**
 * Child process for the proposal-apply durability simulation (7A).
 *
 * Usage: tsx scripts/kill9-applier.ts <storeDir> <vaultRoot> <proposalId>
 *
 * The parent pre-seeds the store with a PENDING append proposal and the target
 * note on disk, then this child approves it (which records {applying}, writes
 * the note via the atomic guarded write, then records {applied}). The parent
 * SIGKILLs at an unpredictable moment. The invariant: no matter when the kill
 * lands, after the parent re-opens the store and runs recoverOnLaunch the note
 * is NEVER double-appended and the proposal is never left stuck in {applying}.
 */
import { ProposalStore } from "../src/main/proposalStore.js";
import { ProposalSession } from "../src/main/proposalSession.js";

async function main(): Promise<void> {
  const storeDir = process.argv[2];
  const vaultRoot = process.argv[3];
  const id = process.argv[4];
  if (!storeDir || !vaultRoot || !id) {
    process.stderr.write("usage: kill9-applier <storeDir> <vaultRoot> <proposalId>\n");
    process.exit(2);
  }
  const store = new ProposalStore(storeDir);
  const session = new ProposalSession({ store, getRoot: () => vaultRoot });

  process.stdout.write("applying\n");
  await session.approve(id);
  process.stdout.write("done\n");
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
