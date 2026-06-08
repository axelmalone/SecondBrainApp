import { atomicWrite } from "./atomicWrite.js";
import { readWithBaseline } from "./hash.js";
import {
  ConflictError,
  NoteDeletedError,
  NoteRenamedError,
} from "./errors.js";
import type { DiskBaseline } from "./types.js";

/**
 * Outcome of a guarded text-level write. Discriminated on `status`.
 *
 * - saved    : the write landed; `baseline` fingerprints the just-written bytes.
 * - conflict : the on-disk file drifted from `baseline` (an external write, e.g.
 *              Obsidian) — NOT clobbered. `disk` + `diskText` describe what is on
 *              disk now so the caller can offer a choice.
 * - deleted  : the target file vanished before the write could land.
 * - renamed  : a file exists at the path but with a different inode (replaced).
 */
export type GuardedApplyResult =
  | { status: "saved"; baseline: DiskBaseline }
  | { status: "conflict"; disk: DiskBaseline; diskText: string }
  | { status: "deleted" }
  | { status: "renamed" };

/**
 * TEXT-LEVEL guarded write (CQ1-C). The single choke point both the editor save
 * path and the proposal-apply path funnel through: it takes a plain string, not
 * an Automerge doc, so it has zero CRDT knowledge. Automerge-specific reconcile
 * (hydrate / 3-way prep) stays in `reconcile.ts`; this is the byte-level half.
 *
 * Wraps `atomicWrite` (which carries the D7 TOCTOU re-hash guard) and turns its
 * typed throws into a discriminated result. On conflict it re-reads the current
 * disk content so the caller can surface a diff without a second round trip.
 *
 * `baseline` is the load-time anchor we promise not to silently clobber. Passing
 * `undefined` is a FRESH CREATE: the write refuses (→ `conflict`) if a file
 * already exists at `path`.
 *
 * VaultIOError (genuine I/O failure) propagates — it is not a drift outcome.
 */
export async function guardedApply(
  path: string,
  baseline: DiskBaseline | undefined,
  fullText: string
): Promise<GuardedApplyResult> {
  try {
    // Only set `baseline` when present — under exactOptionalPropertyTypes an
    // explicit `undefined` is not the same as an absent key (= fresh create).
    const next = await atomicWrite(path, fullText, {
      backup: true,
      ...(baseline ? { baseline } : {}),
    });
    return { status: "saved", baseline: next };
  } catch (err) {
    if (err instanceof NoteDeletedError) return { status: "deleted" };
    if (err instanceof NoteRenamedError) return { status: "renamed" };
    if (err instanceof ConflictError) {
      // The file drifted (or, for a fresh create, already exists). Read what is
      // there now so the caller can diff/keep-both without another round trip.
      try {
        const read = await readWithBaseline(path);
        return {
          status: "conflict",
          disk: read.baseline,
          diskText: read.content.toString("utf8"),
        };
      } catch (readErr) {
        // It vanished in the window between the guard and our read.
        if ((readErr as NodeJS.ErrnoException).code === "ENOENT") {
          return { status: "deleted" };
        }
        throw readErr;
      }
    }
    throw err;
  }
}
