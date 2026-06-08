import { promises as fs } from "node:fs";
import {
  extractWikilinkTargets,
  listMarkdownFiles,
  noteName,
} from "./vaultScan.js";
import type { Backlink } from "../shared/search.js";

/**
 * A lightweight wikilink graph for the backlinks panel (6A). A SEPARATE consumer
 * of the existing vaultWatcher — deliberately NOT folded into the heavy embedder
 * GroundingService, so backlinks work even when grounding is off or not indexed.
 *
 * Holds each note's outgoing target names; backlinks are the reverse lookup. Pure
 * Node + injected scan util, so it is headlessly unit-testable.
 */
export class LinkIndex {
  /** absPath → set of lowercased target note names it links to. */
  private readonly outgoing = new Map<string, Set<string>>();

  /** Full rebuild from disk. Cheap (text only) — safe to call on vault switch. */
  async build(root: string): Promise<void> {
    this.outgoing.clear();
    const files = await listMarkdownFiles(root);
    await Promise.all(files.map((f) => this.reindexNote(f)));
  }

  /** Re-read one note and refresh its outgoing links. */
  async reindexNote(absPath: string): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(absPath, "utf8");
    } catch {
      this.outgoing.delete(absPath);
      return;
    }
    this.outgoing.set(absPath, new Set(extractWikilinkTargets(text)));
  }

  /** Drop a deleted/renamed note. */
  removeNote(absPath: string): void {
    this.outgoing.delete(absPath);
  }

  /** Notes that link to the given note (by its basename), newest-name order. */
  backlinksFor(absPath: string): Backlink[] {
    const targetName = noteName(absPath).toLowerCase();
    const hits: Backlink[] = [];
    for (const [path, targets] of this.outgoing) {
      if (path === absPath) continue; // a note never backlinks itself
      if (targets.has(targetName)) hits.push({ path, name: noteName(path) });
    }
    hits.sort((a, b) => a.name.localeCompare(b.name));
    return hits;
  }
}
