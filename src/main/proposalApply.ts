// Pure text helpers for the proposal apply paths (3A anchored-append + 4C
// trivial-diff normalization). Kept separate from proposalSession so they are
// trivially unit-testable with zero fs / Electron.

/** Ensure a string ends with exactly one trailing newline (unless empty). */
function ensureTrailingNewline(s: string): string {
  if (s.length === 0) return s;
  return s.endsWith("\n") ? s : s + "\n";
}

/**
 * Normalize two texts before deciding they "differ" (4C trivial-diff
 * normalization), so Obsidian autosave adding/removing a trailing newline or
 * CRLF does not spam a false-stale. Deliberately conservative: it normalizes
 * line endings and trailing whitespace only — it never reorders or rewrites
 * content, so a real edit is still detected. (Frontmatter-reorder normalization
 * is a documented future refinement.)
 */
export function normalizeForCompare(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\s+$/, "");
}

/** True if two note texts are equal ignoring only trivial whitespace drift. */
export function triviallyEqual(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

/**
 * Anchored append (3A). Splice `fragment` into `content`:
 *  - no anchor → append at the end of the file.
 *  - anchor present → insert immediately AFTER the line containing the anchor
 *    (a heading or trailing-context snippet). Returns null when the anchor is
 *    not found in the current disk content, so the caller can mark the proposal
 *    stale and re-review rather than misplace the fragment.
 */
export function applyAnchoredAppend(
  content: string,
  anchor: string | undefined,
  fragment: string
): string | null {
  const frag = fragment.replace(/\s+$/, "");

  if (!anchor || anchor.length === 0) {
    const base = ensureTrailingNewline(content);
    return base + frag + "\n";
  }

  const idx = content.indexOf(anchor);
  if (idx === -1) return null;

  const lineEnd = content.indexOf("\n", idx + anchor.length);
  if (lineEnd === -1) {
    // Anchor is on the last line (no trailing newline) → append after it.
    return ensureTrailingNewline(content) + frag + "\n";
  }
  const before = content.slice(0, lineEnd + 1); // includes the line's newline
  const after = content.slice(lineEnd + 1);
  return before + frag + "\n" + after;
}
