import { describe, it, expect } from "vitest";
import {
  AGENTIC_TOOLS,
  READ_NOTE_CAP,
  type ToolContext,
  type ToolNoteRef,
  type ToolSearchHit,
} from "../src/gateway/tools/registry.js";

const search_vault = AGENTIC_TOOLS.search_vault!;
const deep_search = AGENTIC_TOOLS.deep_search!;
const read_note = AGENTIC_TOOLS.read_note!;
const backlinks = AGENTIC_TOOLS.backlinks!;
const follow_links = AGENTIC_TOOLS.follow_links!;
const list_recent = AGENTIC_TOOLS.list_recent!;

/** A ToolContext stub: an in-memory vault keyed by absolute path. resolvePath
 *  applies the .md + "inside vault" guard the real wiring backs with isInside. */
function stubCtx(
  files: Record<string, string>,
  extra: Partial<ToolContext> = {}
): ToolContext {
  return {
    search: (q): ToolSearchHit[] =>
      Object.entries(files)
        .filter(([, text]) => text.toLowerCase().includes(q.toLowerCase()))
        .map(([p, text]) => ({ notePath: p, text })),
    resolvePath: (p) => {
      // Reject traversal + non-markdown (the isInside+.md guard, 3A).
      if (p.includes("..") || p.startsWith("/etc") || !p.endsWith(".md")) return null;
      const abs = p.startsWith("/vault/") ? p : `/vault/${p}`;
      return abs in files ? abs : abs; // resolve even if absent; readFile throws
    },
    readFile: async (abs) => {
      if (!(abs in files)) throw new Error("ENOENT");
      return files[abs] as string;
    },
    ...extra,
  };
}

describe("search_vault", () => {
  it("returns ranked hits with path + snippet; empty query throws (validation)", async () => {
    const ctx = stubCtx({ "/vault/a.md": "pricing decision notes", "/vault/b.md": "garden" });
    const out = await search_vault.run({ query: "pricing" }, ctx);
    expect(out).toContain("/vault/a.md");
    expect(out).toContain("pricing decision");
    expect(out).not.toContain("/vault/b.md");

    await expect(search_vault.run({ query: "   " }, ctx)).rejects.toThrow(/non-empty/);
    await expect(search_vault.run({}, ctx)).rejects.toThrow(/query/);
  });

  it("reports no matches plainly (never fabricates)", async () => {
    const ctx = stubCtx({ "/vault/a.md": "pricing" });
    expect(await search_vault.run({ query: "submarine" }, ctx)).toContain("No notes matched");
  });
});

describe("deep_search (semantic)", () => {
  it("formats semantic hits like search_vault", async () => {
    const ctx = stubCtx(
      {},
      {
        semanticSearch: async (): Promise<ToolSearchHit[]> => [
          { notePath: "/vault/momentum.md", heading: "Long projects", text: "sustaining momentum through the messy middle" },
        ],
      }
    );
    const out = await deep_search.run({ query: "how do I stay motivated" }, ctx);
    expect(out).toContain("/vault/momentum.md › Long projects");
    expect(out).toContain("sustaining momentum");
  });

  it("falls back to keyword search when the vector index isn't ready (null)", async () => {
    const ctx = stubCtx({}, { semanticSearch: async () => null });
    const out = await deep_search.run({ query: "anything" }, ctx);
    expect(out).toMatch(/isn't ready|search_vault/);
  });

  it("reports no semantic matches plainly (never fabricates)", async () => {
    const ctx = stubCtx({}, { semanticSearch: async (): Promise<ToolSearchHit[]> => [] });
    expect(await deep_search.run({ query: "submarine" }, ctx)).toContain("No notes semantically matched");
  });

  it("reports unavailable when the context offers no semantic search", async () => {
    const ctx = stubCtx({ "/vault/a.md": "x" }); // no semanticSearch wired
    const out = await deep_search.run({ query: "x" }, ctx);
    expect(out).toMatch(/unavailable|search_vault/);
  });

  it("validates the query (empty throws)", async () => {
    const ctx = stubCtx({}, { semanticSearch: async () => [] });
    await expect(deep_search.run({ query: "  " }, ctx)).rejects.toThrow(/non-empty/);
    await expect(deep_search.run({}, ctx)).rejects.toThrow(/query/);
  });
});

describe("graph + recency tools", () => {
  it("backlinks lists linking notes; empty + missing-index + validation handled", async () => {
    const ctx = stubCtx(
      {},
      {
        backlinks: (p) =>
          p === "/vault/a.md" ? [{ notePath: "/vault/b.md", name: "b" }] : [],
      }
    );
    expect(await backlinks.run({ path: "/vault/a.md" }, ctx)).toContain("/vault/b.md");
    expect(await backlinks.run({ path: "/vault/lonely.md" }, ctx)).toContain("No notes link to");
    await expect(backlinks.run({}, ctx)).rejects.toThrow(/path/);
    // No backlinks capability wired → reports unavailable, never throws.
    expect(await backlinks.run({ path: "/vault/a.md" }, stubCtx({}))).toMatch(/unavailable/);
  });

  it("follow_links lists outgoing targets and flags dangling ones", async () => {
    const ctx = stubCtx(
      {},
      {
        outgoingLinks: () => [
          { name: "real", notePath: "/vault/real.md" },
          { name: "ghost" },
        ],
      }
    );
    const out = await follow_links.run({ path: "/vault/a.md" }, ctx);
    expect(out).toContain("/vault/real.md");
    expect(out).toContain("ghost (no such note in vault)");
  });

  it("list_recent clamps the limit, defaults to 10, handles empty", async () => {
    const recents = Array.from({ length: 30 }, (_, i) => ({
      notePath: `/vault/n${i}.md`,
      name: `n${i}`,
    }));
    let asked = -1;
    const ctx = stubCtx(
      {},
      {
        recentNotes: async (limit: number): Promise<ToolNoteRef[]> => {
          asked = limit;
          return recents.slice(0, limit);
        },
      }
    );
    await list_recent.run({ limit: 100 }, ctx);
    expect(asked).toBe(25); // clamped to the cap
    await list_recent.run({}, ctx);
    expect(asked).toBe(10); // default
    const empty = stubCtx({}, { recentNotes: async () => [] });
    expect(await list_recent.run({}, empty)).toContain("No notes in the vault");
  });
});

describe("read_note — path safety (3A) + truncation (5A)", () => {
  it("rejects path traversal / non-.md before any read", async () => {
    const ctx = stubCtx({ "/vault/a.md": "ok" });
    await expect(read_note.run({ path: "../../etc/passwd" }, ctx)).rejects.toThrow(/outside the vault|markdown/);
    await expect(read_note.run({ path: "/etc/hosts" }, ctx)).rejects.toThrow(/outside the vault|markdown/);
    await expect(read_note.run({ path: "notes.txt" }, ctx)).rejects.toThrow(/markdown|outside/);
    await expect(read_note.run({}, ctx)).rejects.toThrow(/path/);
  });

  it("reads a note in full when under the cap", async () => {
    const ctx = stubCtx({ "/vault/a.md": "short note body" });
    expect(await read_note.run({ path: "a.md" }, ctx)).toBe("short note body");
  });

  it("caps a long note and emits a continuation marker; offset continues", async () => {
    const big = "x".repeat(READ_NOTE_CAP + 500);
    const ctx = stubCtx({ "/vault/big.md": big });
    const first = await read_note.run({ path: "big.md" }, ctx);
    expect(first).toContain("…[truncated:");
    expect(first).toContain(`of ${big.length} chars`);
    expect(first).toContain(`offset:${READ_NOTE_CAP}`);
    // The visible body is exactly the cap.
    expect(first.split("\n\n…[truncated")[0]).toHaveLength(READ_NOTE_CAP);

    const second = await read_note.run({ path: "big.md", offset: READ_NOTE_CAP }, ctx);
    expect(second).toBe("x".repeat(500)); // the tail, no marker
  });

  it("returns the LIVE editor buffer for the open note (unsaved edits visible)", async () => {
    const ctx = stubCtx(
      { "/vault/open.md": "on-disk content" },
      { activeNotePath: "open.md", activeNoteText: "UNSAVED edit in buffer" }
    );
    expect(await read_note.run({ path: "open.md" }, ctx)).toBe("UNSAVED edit in buffer");
  });
});
