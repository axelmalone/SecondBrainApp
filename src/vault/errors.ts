// Typed error contract for the vault I/O layer.
// No catch-all: every failure mode that callers must branch on is its own class.
// Data-loss safety depends on callers being able to distinguish these precisely.

export type VaultErrorCode =
  | "NoteNotFound"
  | "NoteDeleted"
  | "NoteRenamed"
  | "Conflict"
  | "VaultIO";

export abstract class VaultError extends Error {
  abstract readonly code: VaultErrorCode;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
  }
}

/** The note path did not exist at load time. */
export class NoteNotFoundError extends VaultError {
  readonly code = "NoteNotFound";
  constructor(public readonly path: string, options?: { cause?: unknown }) {
    super(`Note not found: ${path}`, options);
  }
}

/** The note existed at load but was removed from disk before this operation. */
export class NoteDeletedError extends VaultError {
  readonly code = "NoteDeleted";
  constructor(public readonly path: string, options?: { cause?: unknown }) {
    super(`Note was deleted on disk: ${path}`, options);
  }
}

/**
 * The on-disk file was replaced by a different inode (e.g. Obsidian's own
 * atomic rename, or a move) between load and this operation. Distinct from
 * NoteDeleted: a file IS present at the path, but it is not the one we loaded.
 */
export class NoteRenamedError extends VaultError {
  readonly code = "NoteRenamed";
  constructor(public readonly path: string, options?: { cause?: unknown }) {
    super(`Note inode changed on disk (renamed/replaced): ${path}`, options);
  }
}

/**
 * The on-disk content changed since the captured baseline. Surfaced when an
 * atomic write would otherwise clobber an external edit, or when reconcile
 * detects an external write while local edits are unsaved.
 */
export class ConflictError extends VaultError {
  readonly code = "Conflict";
  constructor(public readonly path: string, options?: { cause?: unknown }) {
    super(`On-disk content changed since load: ${path}`, options);
  }
}

/** Any underlying filesystem failure we cannot classify more specifically. */
export class VaultIOError extends VaultError {
  readonly code = "VaultIO";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
