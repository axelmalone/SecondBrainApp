import {
  loadNote,
  guardedApply,
  resolveConflict,
  setText,
  serialize,
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

  // Fold the renderer's text into the live doc, then attempt the guarded write
  // through the shared text-level choke point. The Automerge doc is the editor's
  // canonical buffer; guardedApply only ever sees the serialized markdown.
  loaded.doc = setText(loaded.doc, text);
  try {
    const result = await guardedApply(path, loaded.baseline, serialize(loaded.doc));
    switch (result.status) {
      case "saved":
        loaded.baseline = result.baseline;
        onSaved([path]);
        return { status: "saved", text };
      case "conflict":
        // The write was refused because disk changed — never silently clobber.
        // Stash the disk side so resolve() can offer keep-mine/theirs/both.
        pendingConflicts.set(path, {
          disk: result.disk,
          diskText: result.diskText,
        });
        return { status: "conflict", diskText: result.diskText };
      case "deleted":
        return { status: "deleted" };
      case "renamed":
        return { status: "renamed" };
    }
  } catch (err) {
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
