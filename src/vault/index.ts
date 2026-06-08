export { loadNote } from "./loadNote.js";
export { saveNote } from "./saveNote.js";
export {
  reconcile,
  resolveConflict,
  hasUnsavedEdits,
  type ResolveResult,
} from "./reconcile.js";
export { atomicWrite, type AtomicWriteOptions } from "./atomicWrite.js";
export { guardedApply, type GuardedApplyResult } from "./guardedApply.js";
export { hydrate, serialize, spliceText, setText } from "./automerge.js";
export { sha256, baselineFrom, readWithBaseline, sameContent } from "./hash.js";
export * from "./errors.js";
export type {
  NoteDoc,
  DiskBaseline,
  LoadedNote,
  ReconcileResult,
  ConflictResolution,
} from "./types.js";
