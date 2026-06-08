import { describe, it, expect } from "vitest";
import { PooledEmbedder } from "../src/grounding/pooledEmbedder.js";

// Stub worker that embeds each text to [length] but holds the response until it
// has seen `gate` concurrent in-flight requests — proving N requests run at once.
function gatedStub(gate: number): string {
  return `
    let inflight=0, released=false, buf="";
    process.stdout.write(JSON.stringify({ready:true})+"\\n");
    const queue=[];
    function maybeRelease(){
      if(!released && inflight>=${gate}){ released=true;
        for(const r of queue) process.stdout.write(JSON.stringify(r)+"\\n");
        queue.length=0;
      }
    }
    process.stdin.on("data",c=>{buf+=c;let nl;while((nl=buf.indexOf("\\n"))>=0){
      const line=buf.slice(0,nl);buf=buf.slice(nl+1);if(!line.trim())continue;
      const req=JSON.parse(line); inflight++;
      const res={id:req.id,vectors:req.texts.map(t=>[t.length])};
      if(released){ process.stdout.write(JSON.stringify(res)+"\\n"); }
      else { queue.push(res); maybeRelease(); }
    }});
  `;
}

function pool(size: number, script: string): PooledEmbedder {
  return new PooledEmbedder(
    { command: process.execPath, args: ["-e", script], dimension: 1, idleMs: 0 },
    size
  );
}

describe("PooledEmbedder", () => {
  it("runs up to `size` embeds concurrently across workers", async () => {
    // Each worker withholds its reply until it personally sees 1 in-flight, but
    // collectively the 3 calls must be in flight at once for all to resolve —
    // they only resolve because 3 workers each got one. (gate=1 per worker.)
    const p = pool(3, gatedStub(1));
    try {
      const out = await Promise.all([p.embed(["a"]), p.embed(["bb"]), p.embed(["ccc"])]);
      expect(out).toEqual([[[1]], [[2]], [[3]]]);
      expect(p.size).toBe(3);
    } finally {
      p.dispose();
    }
  });

  it("queues work beyond pool size and still completes every request", async () => {
    // 2 workers, 6 batches → 4 must queue and drain as workers free up.
    const echo = `
      let buf="";
      process.stdout.write(JSON.stringify({ready:true})+"\\n");
      process.stdin.on("data",c=>{buf+=c;let nl;while((nl=buf.indexOf("\\n"))>=0){
        const line=buf.slice(0,nl);buf=buf.slice(nl+1);if(!line.trim())continue;
        const req=JSON.parse(line);
        process.stdout.write(JSON.stringify({id:req.id,vectors:req.texts.map(t=>[t.length])})+"\\n");
      }});
    `;
    const p = pool(2, echo);
    try {
      const inputs = ["a", "bb", "ccc", "dddd", "eeeee", "ffffff"];
      const out = await Promise.all(inputs.map((s) => p.embed([s])));
      expect(out).toEqual(inputs.map((s) => [[s.length]]));
    } finally {
      p.dispose();
    }
  });

  it("returns [] for an empty batch without using a worker", async () => {
    const p = pool(2, "process.exit(1)"); // would error if a worker were spawned
    expect(await p.embed([])).toEqual([]);
    p.dispose();
  });
});
