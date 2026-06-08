import {
  loadNote,
  saveNote,
  reconcile,
  resolveConflict,
  setText,
  serialize,
  ConflictError,
  NoteDeletedError,
  NoteRenamedError,
  type LoadedNote,
  type DiskBaseline,
} from "../vault/index.js";
import type {
  ConflictResolution,
  OpenResult,
  ResolveResult,
  SaveResult,
} from "../shared/ipc.js";

/**
 * In-memory session state for the window. The renderer only ever holds plain
 * text; the authoritative Automerge docs and on-disk baselines live HERE, keyed
 * by absolute path. This keeps the data-loss-critical state in the main process
 * behind the IPC boundary.
 */
const openNotes = new Map<string, LoadedNote>();
const pendingConflicts = new Map<
  string,
  { disk: DiskBaseline; diskText: string }
>();

/**
 * Called after the app writes a note to disk, with the affected path(s). The
 * main bootstrap wires this to mark the write as self-originated (so the vault
 * watcher ignores the event it produces) and to incrementally re-index the
 * note. Decoupled via a setter so this module has no grounding/watcher imports.
 */
type SavedHook = (paths: string[]) => void;
let onSaved: SavedHook = () => {};
export function setOnSaved(hook: SavedHook): void {
  onSaved = hook;
}

export async function openNote(path: string): Promise<OpenResult> {
  const loaded = await loadNote(path);
  openNotes.set(path, loaded);
  return { path, text: serialize(loaded.doc) };
}

export async function saveText(
  path: string,
  text: string
): Promise<SaveResult> {
  const loaded = openNotes.get(path);
  if (!loaded) return { status: "error", message: "note is not open" };

  // Fold the renderer's text into the live doc, then attempt the guarded write.
  loaded.doc = setText(loaded.doc, text);
  try {
    await saveNote(loaded);
    onSaved([path]);
    return { status: "saved", text };
  } catch (err) {
    if (err instanceof NoteDeletedError) return { status: "deleted" };
    if (err instanceof NoteRenamedError) return { status: "renamed" };
    if (err instanceof ConflictError) {
      // The write was refused because disk changed. Find out what happened so
      // we can offer the user a choice — never silently clobber.
      const r = await reconcile(loaded);
      if (r.kind === "conflict") {
        pendingConflicts.set(path, { disk: r.disk, diskText: r.diskText });
        return { status: "conflict", diskText: r.diskText };
      }
      if (r.kind === "deleted") return { status: "deleted" };
      if (r.kind === "renamed") return { status: "renamed" };
      return { status: "error", message: "unexpected post-conflict state" };
    }
    return { status: "error", message: String(err) };
  }
}

export async function resolve(
  path: string,
  resolution: ConflictResolution
): Promise<ResolveResult> {
  const loaded = openNotes.get(path);
  const conflict = pendingConflicts.get(path);
  if (!loaded || !conflict) {
    return { status: "error", message: "no pending conflict for this note" };
  }

  try {
    const res = await resolveConflict(loaded, conflict, resolution);
    pendingConflicts.delete(path);

    switch (res.kind) {
      case "keep-mine":
        openNotes.set(path, res.note);
        onSaved([path]);
        return { status: "keep-mine", text: serialize(res.note.doc) };
      case "take-theirs":
        openNotes.set(path, res.note);
        return { status: "take-theirs", text: serialize(res.note.doc) };
      case "keep-both":
        openNotes.set(path, res.theirs);
        openNotes.set(res.mine.path, res.mine);
        onSaved([res.mine.path]);
        return {
          status: "keep-both",
          theirsText: serialize(res.theirs.doc),
          minePath: res.mine.path,
        };
    }
  } catch (err) {
    return { status: "error", message: String(err) };
  }
}
