import { promises as fs, type Dirent } from "node:fs";
import * as path from "node:path";

const MARKDOWN_EXT = new Set([".md", ".markdown"]);

/**
 * Shared vault scan util (6A). A single recursive walk yielding every markdown
 * file's absolute path, skipping dot-directories (.obsidian, .git, .trash) like
 * the grounding indexer and the file tree. The LinkIndex, SearchIndex, and the
 * wikilink resolver all build on this so they never re-implement the walk.
 */
export async function listMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (MARKDOWN_EXT.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  await walk(root);
  return out;
}

/** The wikilink/display name of a note: its basename without the extension. */
export function noteName(absPath: string): string {
  return path.basename(absPath, path.extname(absPath));
}

/**
 * The `limit` most-recently-modified markdown files, newest first (1C
 * recent-activity context). Builds on listMarkdownFiles, then stats each for
 * its mtime — bounded by `limit` so we never inject the whole vault. Files that
 * can't be stat'd are skipped. Returns absolute paths.
 */
export async function recentMarkdown(
  root: string,
  limit: number
): Promise<string[]> {
  const files = await listMarkdownFiles(root);
  const stamped: { path: string; mtimeMs: number }[] = [];
  for (const f of files) {
    try {
      stamped.push({ path: f, mtimeMs: (await fs.stat(f)).mtimeMs });
    } catch {
      // Skip a file that vanished between the walk and the stat.
    }
  }
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stamped.slice(0, limit).map((s) => s.path);
}

const WIKILINK_RE = /\[\[([^\][]+)\]\]/g;

/**
 * Extract the (lowercased) target NAMES of every [[wikilink]] in a note's text,
 * stripping any |alias and #heading. Shared by the LinkIndex (backlinks) and the
 * wikilink resolver. Brackets with a nested "[" are skipped by the character
 * class, matching the renderer's parser.
 */
export function extractWikilinkTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    let inner = m[1] ?? "";
    const pipe = inner.indexOf("|");
    if (pipe >= 0) inner = inner.slice(0, pipe);
    const hash = inner.indexOf("#");
    if (hash >= 0) inner = inner.slice(0, hash);
    const name = inner.trim().toLowerCase();
    if (name) out.push(name);
  }
  return out;
}
