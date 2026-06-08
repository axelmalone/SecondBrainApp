import { next as A } from "@automerge/automerge";
import type { NoteDoc } from "./types.js";

/**
 * Hydrate a markdown string into a fresh Automerge doc. Called on open.
 * An empty file yields a doc with empty text — never a crash, never null.
 */
export function hydrate(markdown: string): A.Doc<NoteDoc> {
  const doc = A.init<NoteDoc>();
  return A.change(doc, (d) => {
    d.text = markdown;
  });
}

/**
 * Serialize the Automerge doc back to a plain markdown string. Called on save.
 * This is the exact byte payload that the atomic write lands on disk — nothing
 * Automerge-specific leaks to the vault. Obsidian must be able to read it.
 */
export function serialize(doc: A.Doc<NoteDoc>): string {
  return doc.text ?? "";
}

/**
 * Apply a text edit to the in-memory doc as a CRDT splice (not a wholesale
 * replace), preserving edit history for future merge work (M2). Returns a new
 * doc; Automerge docs are immutable snapshots.
 */
export function spliceText(
  doc: A.Doc<NoteDoc>,
  index: number,
  deleteCount: number,
  insert: string
): A.Doc<NoteDoc> {
  return A.change(doc, (d) => {
    A.splice(d, ["text"], index, deleteCount, insert);
  });
}

/** Replace the entire text content. Convenience for tests and take-theirs reloads. */
export function setText(doc: A.Doc<NoteDoc>, markdown: string): A.Doc<NoteDoc> {
  return A.change(doc, (d) => {
    A.updateText(d, ["text"], markdown);
  });
}
