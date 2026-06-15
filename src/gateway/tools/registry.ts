import type { ToolSpec } from "../../shared/ai.js";

/**
 * The agentic READ tools (strangler-fig spike). Pure and Electron-free: every
 * vault capability is injected via ToolContext, so the registry is unit-testable
 * with stubs and the gateway never imports main/ or the vault layer directly.
 *
 * SECURITY (3A): read_note resolves the model-supplied path through
 * `ctx.resolvePath`, which the main wiring backs with the existing isInside(root)
 * + .md guard. A path that escapes the vault (or isn't a markdown note) resolves
 * to null and the tool refuses — path traversal is structurally impossible.
 */

/** One search result handed to the model (notePath + nearest heading + text). */
export interface ToolSearchHit {
  notePath: string;
  heading?: string;
  text: string;
}

/** Vault capabilities the tools need, injected by the main wiring. */
export interface ToolContext {
  /** BM25 keyword search over the vault (LexicalIndex), already top-k + gated. */
  search(query: string, k: number): ToolSearchHit[];
  /** Semantic (embedding) search over the vault — the deep_search engine. Async
   *  because it embeds the query. Resolves to `null` when the vector index isn't
   *  usable yet (still backfilling, empty, or the embed failed) so the tool can
   *  tell the model to fall back to keyword search; `[]` means semantic ran but
   *  found nothing. Optional: when absent, deep_search reports itself unavailable. */
  semanticSearch?(query: string, k: number): Promise<ToolSearchHit[] | null>;
  /** Resolve a model-supplied note path to a safe ABSOLUTE vault path, or null
   *  if it escapes the vault or isn't a .md note (isInside + .md — 3A). */
  resolvePath(notePath: string): string | null;
  /** Read a resolved absolute path's text. Throws if the file is gone. */
  readFile(absPath: string): Promise<string>;
  /** The note open in the editor + its LIVE buffer. read_note returns this for
   *  the open note so the model sees unsaved edits (matches the active-note path). */
  activeNotePath?: string;
  activeNoteText?: string;
  /** Notes that link TO a given note (reverse wikilinks) — the backlinks tool. */
  backlinks?(notePath: string): ToolNoteRef[];
  /** Notes a given note links TO (outgoing wikilinks) — the follow_links tool.
   *  `notePath` is omitted for a dangling link to a note that doesn't exist. */
  outgoingLinks?(notePath: string): { name: string; notePath?: string }[];
  /** The most-recently-edited notes, newest first — the list_recent tool. */
  recentNotes?(limit: number): Promise<ToolNoteRef[]>;
}

/** A note reference (path + display name) returned by the graph/recent tools. */
export interface ToolNoteRef {
  notePath: string;
  name: string;
}

/** A registered tool: its provider-neutral spec + a runner that returns the
 *  tool_result content as a string. Throws on bad input / failure; the agentic
 *  loop catches and feeds the message back as an `{error}` result (4A). */
export interface Tool {
  spec: ToolSpec;
  run(input: unknown, ctx: ToolContext): Promise<string>;
}

const SEARCH_K = 8;
const SNIPPET_CHARS = 220;
/** Max characters returned by one read_note call (5A). */
export const READ_NOTE_CAP = 8000;

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

/** Format search hits into the numbered path › heading + snippet block shared by
 *  search_vault (keyword) and deep_search (semantic), so both speak one language. */
function formatHits(hits: ToolSearchHit[]): string {
  return hits
    .map((h, i) => {
      const label = h.heading ? `${h.notePath} › ${h.heading}` : h.notePath;
      const snippet = h.text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
      return `[${i + 1}] ${label}\n${snippet}`;
    })
    .join("\n\n");
}

/** Validate + extract a non-empty `query` string from a tool's input. */
function requireQuery(input: unknown, tool: string): string {
  const query = asObject(input).query;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error(`${tool} requires a non-empty 'query' string.`);
  }
  return query;
}

/** Validate + extract a non-empty `path` string from a tool's input. */
function requirePath(input: unknown, tool: string): string {
  const p = asObject(input).path;
  if (typeof p !== "string" || p.length === 0) {
    throw new Error(`${tool} requires a 'path' string.`);
  }
  return p;
}

/** Format a list of note references as a numbered path list the model can feed
 *  back into read_note. A reference with no path (a dangling wikilink) is shown
 *  as the bare name so the model knows the target note doesn't exist. */
function formatRefs(refs: { name: string; notePath?: string }[]): string {
  return refs
    .map((r, i) =>
      r.notePath ? `[${i + 1}] ${r.notePath}` : `[${i + 1}] ${r.name} (no such note in vault)`
    )
    .join("\n");
}

const searchVault: Tool = {
  spec: {
    name: "search_vault",
    description:
      "Search the user's note vault by keyword and get back the most relevant " +
      "note excerpts (path, section heading, and a snippet). Use this first to " +
      "find which notes are relevant, then read_note to read one in full.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search for." },
      },
      required: ["query"],
    },
  },
  async run(input, ctx) {
    const query = requireQuery(input, "search_vault");
    const hits = ctx.search(query, SEARCH_K);
    if (hits.length === 0) {
      return `No notes matched "${query}". If the question is conceptual, try deep_search (semantic search).`;
    }
    return formatHits(hits);
  },
};

const deepSearch: Tool = {
  spec: {
    name: "deep_search",
    description:
      "Semantic search over the user's note vault: finds notes related by MEANING, " +
      "not just shared keywords. Reach for this when search_vault returns nothing " +
      "useful, or when the question is conceptual or paraphrased and the relevant " +
      "note may use different words than the query. Returns the same path, section " +
      "heading, and snippet shape as search_vault; then read_note to read one in full.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to find, in natural language (meaning, not just keywords).",
        },
      },
      required: ["query"],
    },
  },
  async run(input, ctx) {
    const query = requireQuery(input, "deep_search");
    if (!ctx.semanticSearch) {
      return "Semantic search is unavailable here. Use search_vault (keyword search) instead.";
    }
    const hits = await ctx.semanticSearch(query, SEARCH_K);
    if (hits === null) {
      return (
        "The semantic index isn't ready yet (still building). " +
        "Use search_vault (keyword search) for now."
      );
    }
    if (hits.length === 0) {
      return `No notes semantically matched "${query}".`;
    }
    return formatHits(hits);
  },
};

const readNote: Tool = {
  spec: {
    name: "read_note",
    description:
      "Read the full text of one note in the vault by its path (as shown in " +
      "search_vault results). For long notes, pass 'offset' to continue past a " +
      "truncation marker.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The note's vault path." },
        offset: {
          type: "number",
          description: "Character offset to start from (for long notes).",
        },
      },
      required: ["path"],
    },
  },
  async run(input, ctx) {
    const args = asObject(input);
    const notePath = args.path;
    if (typeof notePath !== "string" || notePath.length === 0) {
      throw new Error("read_note requires a 'path' string.");
    }
    const abs = ctx.resolvePath(notePath);
    if (abs === null) {
      throw new Error(
        `Cannot read "${notePath}": it is outside the vault or not a markdown note.`
      );
    }
    const offset =
      typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;

    // The open note: use the live editor buffer so unsaved edits are visible.
    let content: string;
    if (
      ctx.activeNotePath !== undefined &&
      ctx.resolvePath(ctx.activeNotePath) === abs &&
      ctx.activeNoteText !== undefined
    ) {
      content = ctx.activeNoteText;
    } else {
      content = await ctx.readFile(abs);
    }

    const slice = content.slice(offset, offset + READ_NOTE_CAP);
    const end = offset + READ_NOTE_CAP;
    if (content.length > end) {
      return (
        slice +
        `\n\n…[truncated: showing ${offset}-${end} of ${content.length} chars. ` +
        `Call read_note again with offset:${end} to continue.]`
      );
    }
    return slice;
  },
};

const backlinks: Tool = {
  spec: {
    name: "backlinks",
    description:
      "List the notes that link TO a given note (its backlinks / reverse " +
      "wikilinks) — what in the vault references it. Pass the note's path (as " +
      "shown in search results); then read_note to open any result.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "The note's vault path." } },
      required: ["path"],
    },
  },
  async run(input, ctx) {
    const notePath = requirePath(input, "backlinks");
    if (!ctx.backlinks) return "The backlinks index is unavailable here.";
    const refs = ctx.backlinks(notePath);
    return refs.length === 0 ? `No notes link to "${notePath}".` : formatRefs(refs);
  },
};

const followLinks: Tool = {
  spec: {
    name: "follow_links",
    description:
      "List the notes a given note links TO (its outgoing wikilinks) — follow a " +
      "thread from one note to the related notes it points at. Pass the note's " +
      "path; then read_note to open any result.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "The note's vault path." } },
      required: ["path"],
    },
  },
  async run(input, ctx) {
    const notePath = requirePath(input, "follow_links");
    if (!ctx.outgoingLinks) return "The link index is unavailable here.";
    const refs = ctx.outgoingLinks(notePath);
    return refs.length === 0 ? `"${notePath}" links to no other notes.` : formatRefs(refs);
  },
};

const listRecent: Tool = {
  spec: {
    name: "list_recent",
    description:
      "List the user's most recently edited notes, newest first — useful when the " +
      "question is about what they've been working on lately. Optional 'limit' " +
      "(default 10). Then read_note to open any result.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many notes to list (default 10)." },
      },
    },
  },
  async run(input, ctx) {
    if (!ctx.recentNotes) return "The recent-notes index is unavailable here.";
    const raw = asObject(input).limit;
    const limit =
      typeof raw === "number" && raw > 0 ? Math.min(Math.floor(raw), 25) : 10;
    const refs = await ctx.recentNotes(limit);
    return refs.length === 0 ? "No notes in the vault yet." : formatRefs(refs);
  },
};

/** The agentic read tools, keyed by name. */
export const AGENTIC_TOOLS: Record<string, Tool> = {
  search_vault: searchVault,
  deep_search: deepSearch,
  read_note: readNote,
  backlinks: backlinks,
  follow_links: followLinks,
  list_recent: listRecent,
};

/** The ToolSpecs to offer the model this turn. */
export const AGENTIC_TOOL_SPECS: ToolSpec[] = Object.values(AGENTIC_TOOLS).map(
  (t) => t.spec
);
