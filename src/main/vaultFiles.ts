import { promises as fs, type Dirent } from "node:fs";
import * as path from "node:path";
import type { FileNode } from "../shared/ipc.js";

const MARKDOWN_EXT = new Set([".md", ".markdown"]);

/**
 * Build the vault's markdown file tree for the sidebar. Skips dot-directories
 * (.obsidian, .git, .trash) exactly like the grounding indexer, and lists dirs
 * before files, each alphabetically. An unreadable directory is skipped rather
 * than failing the whole tree.
 */
export async function listTree(root: string): Promise<FileNode[]> {
  const walk = async (dir: string): Promise<FileNode[]> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const dirs: FileNode[] = [];
    const files: FileNode[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push({
          name: entry.name,
          path: full,
          type: "dir",
          children: await walk(full),
        });
      } else if (MARKDOWN_EXT.has(path.extname(entry.name).toLowerCase())) {
        files.push({ name: entry.name, path: full, type: "file" });
      }
    }
    const byName = (a: FileNode, b: FileNode): number =>
      a.name.localeCompare(b.name);
    dirs.sort(byName);
    files.sort(byName);
    return [...dirs, ...files];
  };
  return walk(root);
}

/** True if `target` resolves to a path inside `root` — blocks path traversal
 *  across the IPC boundary before we ever open a file by path. */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
