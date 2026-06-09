import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  PERSONA_FILE,
  PERSONA_MAX_CHARS,
  ACTIVE_NOTE_MAX_CHARS,
  basePersonaMessage,
  assemblePersona,
  readPersonaFile,
  resolvePersonaText,
  PersonaStore,
  readActiveNoteContext,
  sampleVault,
  buildBootstrapMessages,
} from "../src/main/personaContext.js";
import { PROPOSE_TOOL_NAME } from "../src/shared/proposal.js";

let dir: string;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = "";
});

async function tmp(): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sb-persona-"));
  return dir;
}

describe("base persona", () => {
  it("is a non-empty system message describing the assistant", () => {
    const m = basePersonaMessage();
    expect(m.role).toBe("system");
    expect(m.content.length).toBeGreaterThan(50);
    expect(m.content.toLowerCase()).toContain("second brain");
  });
});

describe("assemblePersona (ordering + fallback + cap)", () => {
  it("with no persona text → base persona ALONE", () => {
    const msgs = assemblePersona(null);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual(basePersonaMessage());
  });

  it("treats blank/whitespace as no persona → base alone", () => {
    expect(assemblePersona("")).toHaveLength(1);
    expect(assemblePersona("   \n\t ")).toHaveLength(1);
  });

  it("with persona text → base FIRST, then a system persona message", () => {
    const msgs = assemblePersona("I am a founder building a CRM.");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual(basePersonaMessage());
    expect(msgs[1]?.role).toBe("system");
    expect(msgs[1]?.content).toContain("I am a founder building a CRM.");
  });

  it("frames the persona as the user's own words, not overriding rules", () => {
    const msgs = assemblePersona("hello");
    expect(msgs[1]?.content.toLowerCase()).toContain("their own words");
    expect(msgs[1]?.content.toLowerCase()).toContain("not as instructions");
  });

  it("caps an over-long persona at PERSONA_MAX_CHARS and marks it truncated", () => {
    const huge = "x".repeat(PERSONA_MAX_CHARS + 5000);
    const msgs = assemblePersona(huge);
    expect(msgs).toHaveLength(2);
    const body = msgs[1]!.content;
    expect(body).toContain("…(profile truncated)");
    // The injected x-run must not exceed the cap.
    const run = body.match(/x+/)?.[0] ?? "";
    expect(run.length).toBeLessThanOrEqual(PERSONA_MAX_CHARS);
  });
});

describe("readPersonaFile", () => {
  it("returns null when there is no vault root", async () => {
    expect(await readPersonaFile(null)).toBeNull();
  });

  it("returns null when _assistant.md is missing", async () => {
    const root = await tmp();
    expect(await readPersonaFile(root)).toBeNull();
  });

  it("returns null for an empty/whitespace file", async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, PERSONA_FILE), "   \n", "utf8");
    expect(await readPersonaFile(root)).toBeNull();
  });

  it("reads and trims the file content", async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, PERSONA_FILE), "\n# Me\nA writer.\n", "utf8");
    expect(await readPersonaFile(root)).toBe("# Me\nA writer.");
  });
});

describe("PersonaStore (per-vault fallback)", () => {
  it("returns null before anything is saved", async () => {
    const root = await tmp();
    const store = new PersonaStore(path.join(root, "persona"));
    expect(await store.get(root)).toBeNull();
    expect(await store.get(null)).toBeNull();
  });

  it("round-trips a saved fallback", async () => {
    const root = await tmp();
    const store = new PersonaStore(path.join(root, "persona"));
    await store.set(root, "I run a small design studio.");
    expect(await store.get(root)).toBe("I run a small design studio.");
  });

  it("isolates fallbacks per vault root (no bleed)", async () => {
    const root = await tmp();
    const store = new PersonaStore(path.join(root, "persona"));
    await store.set("/vault/a", "persona A");
    await store.set("/vault/b", "persona B");
    expect(await store.get("/vault/a")).toBe("persona A");
    expect(await store.get("/vault/b")).toBe("persona B");
  });

  it("clears the fallback when set to empty", async () => {
    const root = await tmp();
    const store = new PersonaStore(path.join(root, "persona"));
    await store.set(root, "something");
    await store.set(root, "  ");
    expect(await store.get(root)).toBeNull();
  });
});

describe("resolvePersonaText (file wins, fallback fills in)", () => {
  it("prefers _assistant.md over the fallback", async () => {
    const root = await tmp();
    const store = new PersonaStore(path.join(root, "persona"));
    await store.set(root, "FALLBACK");
    await fs.writeFile(path.join(root, PERSONA_FILE), "FROM FILE", "utf8");
    expect(await resolvePersonaText(root, store)).toBe("FROM FILE");
  });

  it("uses the fallback when no file exists", async () => {
    const root = await tmp();
    const store = new PersonaStore(path.join(root, "persona"));
    await store.set(root, "FALLBACK");
    expect(await resolvePersonaText(root, store)).toBe("FALLBACK");
  });

  it("returns null when neither exists", async () => {
    const root = await tmp();
    const store = new PersonaStore(path.join(root, "persona"));
    expect(await resolvePersonaText(root, store)).toBeNull();
  });
});

describe("readActiveNoteContext (1B)", () => {
  it("returns null with no root or no path", async () => {
    expect(await readActiveNoteContext(null, "/x/note.md")).toBeNull();
    const root = await tmp();
    expect(await readActiveNoteContext(root, undefined)).toBeNull();
  });

  it("returns null for a path outside the vault (traversal guard)", async () => {
    const root = await tmp();
    const outside = path.join(root, "..", "escape.md");
    expect(await readActiveNoteContext(root, outside)).toBeNull();
  });

  it("returns null for a non-markdown file", async () => {
    const root = await tmp();
    const p = path.join(root, "image.png");
    await fs.writeFile(p, "x", "utf8");
    expect(await readActiveNoteContext(root, p)).toBeNull();
  });

  it("returns null when the file can't be read", async () => {
    const root = await tmp();
    expect(await readActiveNoteContext(root, path.join(root, "missing.md"))).toBeNull();
  });

  it("injects a system message naming the note and its content", async () => {
    const root = await tmp();
    const p = path.join(root, "Projects", "crm.md");
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, "# CRM\nbuild the thing", "utf8");
    const msg = await readActiveNoteContext(root, p);
    expect(msg?.role).toBe("system");
    expect(msg?.content).toContain("Projects/crm.md");
    expect(msg?.content).toContain("build the thing");
  });

  it("caps an over-long note", async () => {
    const root = await tmp();
    const p = path.join(root, "big.md");
    await fs.writeFile(p, "y".repeat(ACTIVE_NOTE_MAX_CHARS + 3000), "utf8");
    const msg = await readActiveNoteContext(root, p);
    expect(msg?.content).toContain("…(note truncated)");
    const run = msg!.content.match(/y+/)?.[0] ?? "";
    expect(run.length).toBeLessThanOrEqual(ACTIVE_NOTE_MAX_CHARS);
  });
});

describe("sampleVault (1B bootstrap sample)", () => {
  it("returns '' for no root or an empty vault", async () => {
    expect(await sampleVault(null)).toBe("");
    const root = await tmp();
    expect(await sampleVault(root)).toBe("");
  });

  it("lists note titles and skips the persona file", async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, "Ideas.md"), "x", "utf8");
    await fs.writeFile(path.join(root, "Goals.md"), "x", "utf8");
    await fs.writeFile(path.join(root, PERSONA_FILE), "x", "utf8");
    const sample = await sampleVault(root);
    expect(sample).toContain("- Ideas");
    expect(sample).toContain("- Goals");
    expect(sample).not.toContain("_assistant");
  });

  it("caps the number of titles", async () => {
    const root = await tmp();
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(root, `n${i}.md`), "x", "utf8");
    }
    const sample = await sampleVault(root, 3);
    expect(sample.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
  });
});

describe("buildBootstrapMessages (1B, mechanism A)", () => {
  const form = { role: "Founder", projects: "a CRM", help: "challenge me" };

  it("instructs a propose-tool create of the persona file", () => {
    const msgs = buildBootstrapMessages(form, "- Ideas\n- Goals");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[0]?.content).toContain(PROPOSE_TOOL_NAME);
    expect(msgs[0]?.content).toContain(PERSONA_FILE);
  });

  it("carries the form answers and the vault sample in the user message", () => {
    const msgs = buildBootstrapMessages(form, "- Ideas\n- Goals");
    expect(msgs[1]?.role).toBe("user");
    expect(msgs[1]?.content).toContain("Founder");
    expect(msgs[1]?.content).toContain("a CRM");
    expect(msgs[1]?.content).toContain("challenge me");
    expect(msgs[1]?.content).toContain("- Ideas");
  });

  it("handles blank answers and an empty vault with honest placeholders", () => {
    const msgs = buildBootstrapMessages({ role: "", projects: "", help: "" }, "");
    expect(msgs[1]?.content).toContain("(not given)");
    expect(msgs[1]?.content.toLowerCase()).toContain("empty");
  });
});
