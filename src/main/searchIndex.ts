import { promises as fs } from "node:fs";
import { listMarkdownFiles, noteName } from "./vaultScan.js";
import type { SearchHit } from "../shared/search.js";

const DEFAULT_LIMIT = 30;
const SNIPPET_RADIUS = 40;

/**
 * A lightweight in-memory full-text index for the glass-box search (6A). Like
 * LinkIndex, a SEPARATE vaultWatcher consumer — NOT folded into GroundingService
 * — so search works the instant the app opens, with no embedding model, even
 * when grounding is off or mid-index. Incremental per-note updates keep it fresh;
 * the renderer debounces the query (~150ms) so typing never janks.
 */
export class SearchIndex {
  /** absPath → { original text, lowercased text for matching }. */
  private readonly docs = new Map<string, { text: string; lower: string }>();

  async build(root: string): Promise<void> {
    this.docs.clear();
    const files = await listMarkdownFiles(root);
    await Promise.all(files.map((f) => this.reindexNote(f)));
  }

  async reindexNote(absPath: string): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(absPath, "utf8");
    } catch {
      this.docs.delete(absPath);
      return;
    }
    this.docs.set(absPath, { text, lower: text.toLowerCase() });
  }

  removeNote(absPath: string): void {
    this.docs.delete(absPath);
  }

  /**
   * Case-insensitive substring search across note names + bodies. Ranks by
   * match count (a name match counts extra), returns a snippet around the first
   * body hit. Empty query → no results.
   */
  search(query: string, limit = DEFAULT_LIMIT): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];

    const scored: { hit: SearchHit; score: number }[] = [];
    for (const [path, doc] of this.docs) {
      const name = noteName(path);
      const nameMatch = name.toLowerCase().includes(q);
      const idx = doc.lower.indexOf(q);
      if (!nameMatch && idx < 0) continue;

      const occurrences = countOccurrences(doc.lower, q);
      const score = occurrences + (nameMatch ? 5 : 0);
      const snippet = idx >= 0 ? makeSnippet(doc.text, idx, q.length) : name;
      scored.push({ hit: { path, name, snippet }, score });
    }
    scored.sort((a, b) => b.score - a.score || a.hit.name.localeCompare(b.hit.name));
    return scored.slice(0, limit).map((s) => s.hit);
  }
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/** A one-line snippet around the match, single-spaced with ellipses. */
function makeSnippet(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + len + SNIPPET_RADIUS);
  let s = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = "…" + s;
  if (end < text.length) s = s + "…";
  return s;
}
