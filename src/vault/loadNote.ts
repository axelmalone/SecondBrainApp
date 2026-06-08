import { readWithBaseline } from "./hash.js";
import { hydrate } from "./automerge.js";
import { NoteNotFoundError, VaultIOError } from "./errors.js";
import type { LoadedNote } from "./types.js";

/**
 * Open a note from disk into an in-memory Automerge edit buffer, capturing the
 * on-disk baseline at the same moment. The baseline is the conflict-detection
 * anchor every later save/reconcile compares against.
 *
 * - Empty file → empty doc, no crash.
 * - Missing file → typed NoteNotFoundError, no partial doc returned.
 */
export async function loadNote(path: string): Promise<LoadedNote> {
  let read;
  try {
    read = await readWithBaseline(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NoteNotFoundError(path, { cause: err });
    }
    throw new VaultIOError(`failed to load note: ${path}`, { cause: err });
  }

  const markdown = read.content.toString("utf8");
  return {
    path,
    doc: hydrate(markdown),
    baseline: read.baseline,
  };
}
