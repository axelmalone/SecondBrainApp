import type { next } from "@automerge/automerge";

type Doc<T> = next.Doc<T>;

/**
 * The Automerge document shape for a single note. The markdown body lives in
 * `text` as a CRDT-editable string. This doc is the in-memory canonical edit
 * buffer; plain markdown is what lands on disk.
 */
export interface NoteDoc {
  text: string;
}

/**
 * A fingerprint of the on-disk file, captured at load time. Used by reconcile
 * and atomicWrite to detect external writes (Obsidian) without re-reading the
 * whole file: mtime + size are the cheap gate, sha256 is the authority.
 *
 * `ino` lets us tell a content-change apart from an inode swap (rename/replace).
 */
export interface DiskBaseline {
  mtimeMs: number;
  size: number;
  ino: number;
  sha256: string;
}

/**
 * The result of loadNote: the live Automerge doc plus the baseline captured at
 * the moment of read. The baseline is what every later safety check compares
 * against — it is the load-time "truth" we promise not to silently clobber.
 */
export interface LoadedNote {
  path: string;
  doc: Doc<NoteDoc>;
  baseline: DiskBaseline;
}

/** Outcome of a reconcile() call. Discriminated on `kind`. */
export type ReconcileResult =
  | { kind: "unchanged" }
  | { kind: "reloaded"; loaded: LoadedNote }
  | { kind: "conflict"; disk: DiskBaseline; diskText: string }
  | { kind: "deleted" }
  | { kind: "renamed" };

/** How a detected conflict should be resolved by the caller's choice. */
export type ConflictResolution = "keep-mine" | "take-theirs" | "keep-both";
