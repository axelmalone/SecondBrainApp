import { describe, it, expect } from "vitest";
import {
  AGENTIC_TOOLS,
  READ_NOTE_CAP,
  type ToolContext,
  type ToolSearchHit,
} from "../src/gateway/tools/registry.js";

const search_vault = AGENTIC_TOOLS.search_vault!;
const read_note = AGENTIC_TOOLS.read_note!;

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
