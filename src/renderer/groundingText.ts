// Pure (DOM-free) text helpers for the D12 grounding surface — split out of
// renderer.ts so the wording logic is unit-testable in the Node test env
// (renderer.ts has top-level DOM side effects and can't be imported in a test).
// renderer.ts imports these for the badge, the sidenotes, and the #sr-announce
// (aria-live) screen-reader announcement.

import type { GroundingMeta, GroundingSource, GroundingUnavailableReason } from "../shared/ai.js";

/** Human-readable cause shown/spoken when an answer was NOT vault-grounded. */
export const UNGROUNDED_REASON: Record<GroundingUnavailableReason, string> = {
  off: "grounding off",
  "not-indexed": "vault not indexed yet",
  "empty-index": "no notes indexed",
  "embed-failed": "vault search failed",
  "no-matches": "no relevant notes found",
};

/** A note's display name: the filename without the .md/.markdown extension. */
export function noteName(notePath: string): string {
  const base = notePath.split("/").pop() ?? notePath;
  return base.replace(/\.(md|markdown)$/i, "");
}

/** Unique note display names, preserving first-seen order. */
export function uniqueNoteNames(sources: readonly GroundingSource[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sources) {
    if (seen.has(s.notePath)) continue;
    seen.add(s.notePath);
    out.push(noteName(s.notePath));
  }
  return out;
}

/**
 * The spoken (screen-reader) form of an answer's grounding state — the D12 trust
 * signal made audible. A blind user silently receiving an ungrounded answer is
 * the exact D12 failure the visual badge guards against; this is its aria-live
 * twin. Mirrors makeBadge's wording.
 */
export function groundingAnnouncement(grounding: GroundingMeta): string {
  if (grounding.grounded) {
    const names = uniqueNoteNames(grounding.sources);
    return names.length > 0
      ? `Answer grounded in ${names.length} note${names.length === 1 ? "" : "s"}: ${names.join(", ")}.`
      : "Answer grounded in your vault.";
  }
  return `Answering without vault context: ${UNGROUNDED_REASON[grounding.reason]}.`;
}
