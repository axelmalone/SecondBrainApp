import { atomicWrite } from "./atomicWrite.js";
import { serialize } from "./automerge.js";
import type { next } from "@automerge/automerge";

type Doc<T> = next.Doc<T>;
import type { LoadedNote, NoteDoc } from "./types.js";

/**
 * Serialize the live Automerge doc to plain markdown and write it back to disk
 * atomically, guarded against clobbering an external (Obsidian) write.
 *
 * Pass the same `LoadedNote` returned by loadNote (or the previous saveNote):
 * its baseline is the D7 guard anchor. On success the loaded note's baseline is
 * advanced in place to the just-written state, so the same object can be saved
 * again without reloading.
 *
 * Throws ConflictError / NoteDeletedError / NoteRenamedError (from atomicWrite)
 * rather than overwriting a changed file — the caller must run reconcile.
 */
export async function saveNote(
  loaded: LoadedNote,
  doc: Doc<NoteDoc> = loaded.doc
): Promise<LoadedNote> {
  const markdown = serialize(doc);
  const baseline = await atomicWrite(loaded.path, markdown, {
    baseline: loaded.baseline,
    backup: true,
  });
  loaded.doc = doc;
  loaded.baseline = baseline;
  return loaded;
}
