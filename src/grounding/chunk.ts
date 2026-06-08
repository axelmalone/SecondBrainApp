import type { Chunk } from "./types.js";

export interface ChunkOptions {
  /** Soft maximum characters per chunk; blocks are packed until exceeded. */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 1000;

function isHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line.trim());
}

/**
 * Split a note's markdown into retrieval chunks. Strategy: break on blank
 * lines into blocks, track the nearest enclosing heading, and pack consecutive
 * blocks into a chunk until it would exceed maxChars. A heading starts a fresh
 * chunk so a section's heading stays attached to its body. Empty/whitespace
 * blocks are dropped. This is deliberately simple — no semantic splitting; the
 * embedding does the heavy lifting.
 */
export function chunkMarkdown(
  notePath: string,
  markdown: string,
  options: ChunkOptions = {}
): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const lines = markdown.split(/\r?\n/);

  const chunks: Chunk[] = [];
  let ordinal = 0;
  let heading: string | undefined;
  let buf: string[] = [];

  const flush = (): void => {
    const text = buf.join("\n").trim();
    buf = [];
    if (text.length === 0) return;
    const chunk: Chunk = {
      id: `${notePath}#${ordinal}`,
      notePath,
      text,
    };
    if (heading !== undefined) chunk.heading = heading;
    chunks.push(chunk);
    ordinal += 1;
  };

  let blockHasContent = false;
  for (const line of lines) {
    if (isHeading(line)) {
      // A heading boundary closes the current chunk and updates context.
      flush();
      heading = line.trim().replace(/^#{1,6}\s+/, "");
      buf.push(line);
      blockHasContent = true;
      continue;
    }

    if (line.trim() === "") {
      // Blank line = block boundary; flush if the pending chunk is big enough.
      if (blockHasContent && buf.join("\n").length >= maxChars) flush();
      buf.push(line);
      blockHasContent = false;
      continue;
    }

    buf.push(line);
    blockHasContent = true;
  }
  flush();

  return chunks;
}
