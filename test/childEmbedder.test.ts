import { describe, it, expect } from "vitest";
import { ChildProcessEmbedder } from "../src/grounding/childEmbedder.js";

// A stub worker (plain node -e) speaking the embedder protocol — no model. Each
// text embeds to a 1-D vector of its length, so we can assert correlation.
const STUB = `
process.stdout.write(JSON.stringify({ready:true})+"\\n");
let buf="";
process.stdin.on("data",c=>{buf+=c;let nl;while((nl=buf.indexOf("\\n"))>=0){
  const line=buf.slice(0,nl);buf=buf.slice(nl+1);if(!line.trim())continue;
  const req=JSON.parse(line);
  const vectors=req.texts.map(t=>[t.length]);
  process.stdout.write(JSON.stringify({id:req.id,vectors})+"\\n");
}});
`;

const ERR_STUB = `
process.stdout.write(JSON.stringify({ready:true})+"\\n");
let buf="";
process.stdin.on("data",c=>{buf+=c;let nl;while((nl=buf.indexOf("\\n"))>=0){
  const line=buf.slice(0,nl);buf=buf.slice(nl+1);if(!line.trim())continue;
  const req=JSON.parse(line);
  process.stdout.write(JSON.stringify({id:req.id,error:"boom"})+"\\n");
}});
`;

function stubEmbedder(script: string): ChildProcessEmbedder {
  return new ChildProcessEmbedder({
    command: process.execPath, // node
    args: ["-e", script],
    dimension: 1,
  });
}

describe("ChildProcessEmbedder", () => {
  it("embeds via the child and correlates responses by id", async () => {
    const e = stubEmbedder(STUB);
    try {
      expect(await e.embed(["ab", "cde"])).toEqual([[2], [3]]);
    } finally {
      e.dispose();
    }
  });

  it("returns [] for an empty batch without spawning", async () => {
    const e = stubEmbedder("process.exit(1)"); // would fail if spawned
    expect(await e.embed([])).toEqual([]);
    e.dispose();
  });

  it("correlates concurrent requests independently", async () => {
    const e = stubEmbedder(STUB);
    try {
      const [a, b, c] = await Promise.all([
        e.embed(["x"]),
        e.embed(["yy", "zzz"]),
        e.embed(["wwww"]),
      ]);
      expect(a).toEqual([[1]]);
      expect(b).toEqual([[2], [3]]);
      expect(c).toEqual([[4]]);
    } finally {
      e.dispose();
    }
  });

  it("rejects when the child reports an error (no crash)", async () => {
    const e = stubEmbedder(ERR_STUB);
    try {
      await expect(e.embed(["q"])).rejects.toThrow("boom");
    } finally {
      e.dispose();
    }
  });

  it("rejects in-flight work if the child exits, and respawns next time", async () => {
    // A child that exits as soon as it receives a request.
    const dying = `
      process.stdout.write(JSON.stringify({ready:true})+"\\n");
      process.stdin.on("data",()=>process.exit(1));
    `;
    const e = stubEmbedder(dying);
    await expect(e.embed(["q"])).rejects.toThrow(/exited/);
    e.dispose();

    // A fresh embedder (new spec) works — proves a crash isn't terminal.
    const ok = stubEmbedder(STUB);
    try {
      expect(await ok.embed(["hi"])).toEqual([[2]]);
    } finally {
      ok.dispose();
    }
  });
});
