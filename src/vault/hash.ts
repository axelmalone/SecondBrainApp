import { createHash } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import type { DiskBaseline } from "./types.js";

/** sha256 hex of a buffer. */
export function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Build a baseline fingerprint from already-read stats + content. */
export function baselineFrom(stats: Stats, content: Buffer): DiskBaseline {
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    ino: stats.ino,
    sha256: sha256(content),
  };
}

/**
 * Read a file and capture its baseline in one shot. We stat AFTER read so the
 * mtime/size reflect the exact bytes we hashed (a write landing between read
 * and stat would change mtime, which reconcile would then catch on next check).
 */
export async function readWithBaseline(
  path: string
): Promise<{ content: Buffer; baseline: DiskBaseline }> {
  const content = await fs.readFile(path);
  const stats = await fs.stat(path);
  return { content, baseline: baselineFrom(stats, content) };
}

/** True if two baselines describe the same on-disk content (sha256 is authority). */
export function sameContent(a: DiskBaseline, b: DiskBaseline): boolean {
  return a.sha256 === b.sha256;
}
