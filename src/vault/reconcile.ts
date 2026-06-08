import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicWrite } from "./atomicWrite.js";
import { serialize, hydrate } from "./automerge.js";
import { baselineFrom, sha256 } from "./hash.js";
import { loadNote } from "./loadNote.js";
import { VaultIOError } from "./errors.js";
import type {
  ConflictResolution,
  DiskBaseline,
  LoadedNote,
  ReconcileResult,
} from "./types.js";

/** sha256 of the markdown the in-memory doc currently serializes to. */
function localSha(loaded: LoadedNote): string {
  return sha256(serialize(loaded.doc));
}

/** True if the in-memory doc has edits not yet reflected in its baseline. */
export function hasUnsavedEdits(loaded: LoadedNote): boolean {
  return localSha(loaded) !== loaded.baseline.sha256;
}

/**
 * Compare the on-disk file to the baseline captured at load and decide what to
 * do. NEVER auto-merges text (that is M2). Outcomes:
 *
 * - unchanged : disk matches baseline → nothing to do.
 * - reloaded  : disk changed externally AND no unsaved local edits → silent
 *               reload; the new disk content becomes the Automerge base.
 * - conflict  : disk changed externally AND local edits are unsaved → caller
 *               must pick keep-mine / take-theirs / keep-both.
 * - deleted   : the file is gone from disk.
 * - renamed   : a file exists at the path but with a different inode (the one
 *               we loaded was replaced/moved).
 */
export async function reconcile(loaded: LoadedNote): Promise<ReconcileResult> {
  let stats;
  try {
    stats = await fs.stat(loaded.path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "deleted" };
    }
    throw new VaultIOError(`reconcile stat failed: ${loaded.path}`, {
      cause: err,
    });
  }

  if (stats.ino !== loaded.baseline.ino) {
    return { kind: "renamed" };
  }

  // Cheap gate first; only hash when mtime or size moved.
  if (
    stats.mtimeMs === loaded.baseline.mtimeMs &&
    stats.size === loaded.baseline.size
  ) {
    return { kind: "unchanged" };
  }

  const content = await fs.readFile(loaded.path);
  const disk = baselineFrom(stats, content);
  if (disk.sha256 === loaded.baseline.sha256) {
    // mtime/size moved but bytes are identical (e.g. touch) — not a real change.
    return { kind: "unchanged" };
  }

  if (!hasUnsavedEdits(loaded)) {
    const reloaded: LoadedNote = {
      path: loaded.path,
      doc: hydrate(content.toString("utf8")),
      baseline: disk,
    };
    return { kind: "reloaded", loaded: reloaded };
  }

  return { kind: "conflict", disk, diskText: content.toString("utf8") };
}

/** Local YYYY-MM-DD used in the conflict sibling filename. */
function dateStamp(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Find a free sibling path of the form `name (conflict DATE).md`, appending a
 * counter if that name is already taken (multiple conflicts on the same day).
 */
async function freeConflictPath(original: string, now: Date): Promise<string> {
  const dir = path.dirname(original);
  const ext = path.extname(original);
  const base = path.basename(original, ext);
  const stamp = dateStamp(now);
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : ` ${n}`;
    const candidate = path.join(dir, `${base} (conflict ${stamp}${suffix})${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate; // does not exist → free
    }
  }
}

export type ResolveResult =
  | { kind: "keep-mine"; note: LoadedNote }
  | { kind: "take-theirs"; note: LoadedNote }
  | { kind: "keep-both"; mine: LoadedNote; theirs: LoadedNote };

/**
 * Resolve a detected conflict per the caller's choice. The `conflict` argument
 * is the result returned by reconcile() (carries the disk baseline + text).
 *
 * - keep-mine  : my in-memory version overwrites disk (acknowledging their
 *                write as the new guard anchor first, so the atomic write is
 *                still guarded against a *further* race).
 * - take-theirs: discard my edits, reload the disk version into the doc.
 * - keep-both  : write my version to a `name (conflict DATE).md` sibling and
 *                reload the original to the disk version — BOTH sides survive
 *                on disk, nothing is merged.
 */
export async function resolveConflict(
  loaded: LoadedNote,
  conflict: { disk: DiskBaseline; diskText: string },
  resolution: ConflictResolution,
  now: Date = new Date()
): Promise<ResolveResult> {
  switch (resolution) {
    case "keep-mine": {
      // Adopt their write as the guard anchor, then write mine over it.
      loaded.baseline = conflict.disk;
      const baseline = await atomicWrite(loaded.path, serialize(loaded.doc), {
        baseline: conflict.disk,
        backup: true,
      });
      loaded.baseline = baseline;
      return { kind: "keep-mine", note: loaded };
    }

    case "take-theirs": {
      const reloaded = await loadNote(loaded.path);
      return { kind: "take-theirs", note: reloaded };
    }

    case "keep-both": {
      const minePath = await freeConflictPath(loaded.path, now);
      const mineText = serialize(loaded.doc);
      // Fresh-create the sibling (no baseline → guarded against clobbering).
      const mineBaseline = await atomicWrite(minePath, mineText, {
        backup: false,
      });
      const mine: LoadedNote = {
        path: minePath,
        doc: hydrate(mineText),
        baseline: mineBaseline,
      };
      // Original now holds their version.
      const theirs = await loadNote(loaded.path);
      return { kind: "keep-both", mine, theirs };
    }
  }
}
