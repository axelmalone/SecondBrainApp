import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { DiskBaseline } from "./types.js";
import { sha256 } from "./hash.js";
import {
  ConflictError,
  NoteDeletedError,
  NoteRenamedError,
  VaultIOError,
} from "./errors.js";

export interface AtomicWriteOptions {
  /**
   * The baseline captured at load. When provided, the write is guarded:
   * the on-disk file is re-stat'd + re-hashed immediately before the rename
   * and the write ABORTS (no clobber) if it no longer matches. When omitted,
   * the write is treated as a fresh create and aborts if a file already exists.
   */
  baseline?: DiskBaseline;
  /** Write a `.bak` copy of the existing file before replacing it. Default true. */
  backup?: boolean;
}

function tmpPathFor(target: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(8).toString("hex")}.tmp`
  );
}

function backupPathFor(target: string): string {
  return `${target}.bak`;
}

/** fsync a file path durably (open → sync → close). Best-effort on the dir. */
async function fsyncPath(p: string): Promise<void> {
  const fh = await fs.open(p, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Re-stat + re-hash the on-disk target IMMEDIATELY before rename, in the same
 * critical section (D7). This closes the TOCTOU window between the load-time
 * baseline and the moment we replace the file: if Obsidian (or anyone) wrote
 * the file after we loaded it, we abort to a typed error rather than clobber.
 *
 * Distinguishes: file gone (NoteDeleted), inode swapped (NoteRenamed),
 * content changed (Conflict). Throws nothing only when the on-disk state still
 * exactly matches the baseline.
 */
async function guardOrThrow(
  target: string,
  baseline: DiskBaseline | undefined
): Promise<void> {
  let stats;
  try {
    stats = await fs.stat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // No file present at the target.
      if (baseline) {
        // We loaded a file here; it vanished before we could save. Do not recreate.
        throw new NoteDeletedError(target, { cause: err });
      }
      return; // fresh create, nothing to clobber — proceed
    }
    throw new VaultIOError(`stat failed during write guard: ${target}`, {
      cause: err,
    });
  }

  if (!baseline) {
    // Fresh-create requested but a file already exists — refuse to clobber.
    throw new ConflictError(target);
  }
  if (stats.ino !== baseline.ino) {
    throw new NoteRenamedError(target);
  }
  const current = await fs.readFile(target);
  if (sha256(current) !== baseline.sha256) {
    throw new ConflictError(target);
  }
}

/**
 * Atomically write `content` to `target`:
 *   1. write a sibling temp file, fsync it, close it,
 *   2. back up the existing file to `<target>.bak` (if any),
 *   3. re-stat + re-hash the original as the LAST step before rename (D7 guard),
 *   4. rename temp → target (atomic on POSIX), fsync the directory.
 *
 * Crash safety: if the process is killed at any point before the rename, the
 * original file is untouched (the temp is an orphan, cleaned up on next write).
 * The rename itself is atomic, so a reader sees either the old file or the new
 * one in full — never a partial.
 *
 * Returns the new baseline for the freshly written content.
 */
export async function atomicWrite(
  target: string,
  content: string,
  options: AtomicWriteOptions = {}
): Promise<DiskBaseline> {
  const { baseline, backup = true } = options;
  const buf = Buffer.from(content, "utf8");
  const tmp = tmpPathFor(target);
  const dir = path.dirname(target);

  // 1. Write + fsync the temp file so its bytes are durable before we rename.
  try {
    const fh = await fs.open(tmp, "wx");
    try {
      await fh.writeFile(buf);
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw new VaultIOError(`failed writing temp file for ${target}`, {
      cause: err,
    });
  }

  try {
    // 2. Backup-before-write (only if an existing file is present).
    if (backup && baseline) {
      try {
        await fs.copyFile(target, backupPathFor(target));
        await fsyncPath(backupPathFor(target));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new VaultIOError(`failed creating backup for ${target}`, {
            cause: err,
          });
        }
        // ENOENT here means the file vanished; the guard below reports it typed.
      }
    }

    // 3. D7 TOCTOU guard — the last read before the rename. Throws on any drift.
    await guardOrThrow(target, baseline);

    // 4. Atomic replace, then durably persist the directory entry.
    await fs.rename(tmp, target);
    try {
      await fsyncPath(dir);
    } catch {
      // Directory fsync is best-effort; not all platforms permit it.
    }
  } catch (err) {
    // Never leave a temp behind on a failed/aborted write.
    await fs.rm(tmp, { force: true });
    throw err;
  }

  const stats = await fs.stat(target);
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    ino: stats.ino,
    sha256: sha256(buf),
  };
}
