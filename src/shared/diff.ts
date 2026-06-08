// A small line-level diff for the diff-review UX (the load-bearing trust
// surface). Produces a block model the renderer turns into a multi-hunk diff,
// plus a composer that rebuilds the target text from a subset of approved hunks
// (hunk-vs-whole approval). Plain data + pure functions — safe in the renderer,
// unit-testable headlessly.

/** A diff block: either unchanged context, or a change (deletions + additions). */
export type DiffBlock =
  | { type: "context"; lines: string[] }
  | { type: "change"; id: number; del: string[]; add: string[] };

function splitLines(s: string): string[] {
  if (s === "") return [];
  // Trailing newline shouldn't create a phantom empty final line in the diff.
  return s.replace(/\n$/, "").split("\n");
}

/** Longest-common-subsequence over lines (classic DP). */
function lcs(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  return dp;
}

/**
 * Diff `base` → `next` into blocks. Consecutive deletions/additions are grouped
 * into a single change block with a stable id (its order index), so the renderer
 * can offer a per-hunk include toggle and composeBlocks can rebuild the result.
 */
export function diffBlocks(base: string, next: string): DiffBlock[] {
  const a = splitLines(base);
  const b = splitLines(next);
  const dp = lcs(a, b);

  const blocks: DiffBlock[] = [];
  let changeId = 0;
  let context: string[] = [];
  let del: string[] = [];
  let add: string[] = [];

  const flushContext = (): void => {
    if (context.length) {
      blocks.push({ type: "context", lines: context });
      context = [];
    }
  };
  const flushChange = (): void => {
    if (del.length || add.length) {
      blocks.push({ type: "change", id: changeId++, del, add });
      del = [];
      add = [];
    }
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      flushChange();
      context.push(a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      flushContext();
      del.push(a[i]!);
      i++;
    } else {
      flushContext();
      add.push(b[j]!);
      j++;
    }
  }
  while (i < a.length) {
    flushContext();
    del.push(a[i]!);
    i++;
  }
  while (j < b.length) {
    flushContext();
    add.push(b[j]!);
    j++;
  }
  flushContext();
  flushChange();
  return blocks;
}

/**
 * Rebuild the target text from the diff blocks, applying ONLY the change hunks
 * whose id is in `selected` (the rest keep their original/deleted lines). This is
 * how "approve some hunks, not the whole edit" produces the exact text to write.
 */
export function composeBlocks(blocks: DiffBlock[], selected: Set<number>): string {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === "context") {
      out.push(...block.lines);
    } else if (selected.has(block.id)) {
      out.push(...block.add);
    } else {
      out.push(...block.del);
    }
  }
  return out.length ? out.join("\n") + "\n" : "";
}

/** True when every change hunk is selected (i.e. approving the whole edit). */
export function allSelected(blocks: DiffBlock[], selected: Set<number>): boolean {
  return blocks.every((b) => b.type !== "change" || selected.has(b.id));
}
