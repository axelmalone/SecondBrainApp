import type { Chunk, LexicalSearch, ScoredChunk } from "./types.js";

/**
 * Chunk-level lexical (BM25) index — the INSTANT grounding path. Built from the
 * same `chunkMarkdown` pass that feeds the embedder (so chunk ids/headings align
 * with the vector index and the `[n]` citation contract holds), but with no
 * model: pure tokenize + stem + score. This is what lets grounding answer the
 * moment the user clicks "Index" while the embeddings backfill in the background.
 *
 * Deliberately separate from the note-level substring `SearchIndex` (src/main):
 * that serves the search panel with exact-term `indexOf`; this serves grounding
 * with tokenized BM25 over chunks, which is what natural-language questions need.
 */

// A compact stopword list — common function words carry no retrieval signal and
// only dilute BM25 scores. Kept small and explicit (local-first, no dependency).
const STOPWORDS = new Set(
  (
    "a an and are as at be been being but by for from had has have he her his " +
    "i if in into is it its me my no not of on or our she so such that the their " +
    "then there these they this to was were what when where which who will with " +
    "you your do does did how why can could would should"
  ).split(" ")
);

/**
 * Classic Porter stemmer (Porter, 1980) — reduces inflected forms to a common
 * stem so "decided" / "decision" / "deciding" all match a query for "decide".
 * This is the well-known reference algorithm, hand-rolled to stay dependency-free
 * (it's a ~100-line text util, not worth a supply-chain dependency for a
 * local-first app). Pinned to the published Porter test vocabulary in the tests.
 */
const step2list: Record<string, string> = {
  ational: "ate", tional: "tion", enci: "ence", anci: "ance", izer: "ize",
  bli: "ble", alli: "al", entli: "ent", eli: "e", ousli: "ous",
  ization: "ize", ation: "ate", ator: "ate", alism: "al", iveness: "ive",
  fulness: "ful", ousness: "ous", aliti: "al", iviti: "ive", biliti: "ble",
  logi: "log",
};
const step3list: Record<string, string> = {
  icate: "ic", ative: "", alize: "al", iciti: "ic", ical: "ic", ful: "", ness: "",
};

const cons = "[^aeiou]";
const vowel = "[aeiouy]";
const consSeq = cons + "[^aeiouy]*";
const vowelSeq = vowel + "[aeiou]*";
const MGR0 = new RegExp("^(" + consSeq + ")?" + vowelSeq + consSeq);
const MEQ1 = new RegExp("^(" + consSeq + ")?" + vowelSeq + consSeq + "(" + vowelSeq + ")?$");
const MGR1 = new RegExp("^(" + consSeq + ")?" + vowelSeq + consSeq + vowelSeq + consSeq);
const S_V = new RegExp("^(" + consSeq + ")?" + vowel);

export function stem(word: string): string {
  if (word.length < 3) return word;
  let w = word;
  let stemPart: string;
  let re: RegExp;
  let re2: RegExp;
  let re3: RegExp;
  let re4: RegExp;

  const firstch = w[0];
  if (firstch === "y") w = "Y" + w.slice(1);

  // Step 1a
  re = /^(.+?)(ss|i)es$/;
  re2 = /^(.+?)([^s])s$/;
  if (re.test(w)) w = w.replace(re, "$1$2");
  else if (re2.test(w)) w = w.replace(re2, "$1$2");

  // Step 1b
  re = /^(.+?)eed$/;
  re2 = /^(.+?)(ed|ing)$/;
  if (re.test(w)) {
    const fp = re.exec(w) as RegExpExecArray;
    re = new RegExp(MGR0.source);
    if (re.test(fp[1] as string)) w = w.replace(/.$/, "");
  } else if (re2.test(w)) {
    const fp = re2.exec(w) as RegExpExecArray;
    stemPart = fp[1] as string;
    re2 = new RegExp(S_V.source);
    if (re2.test(stemPart)) {
      w = stemPart;
      re2 = /(at|bl|iz)$/;
      re3 = /([^aeiouylsz])\1$/;
      re4 = new RegExp("^" + consSeq + vowel + "[^aeiouwxy]$");
      if (re2.test(w)) w = w + "e";
      else if (re3.test(w)) w = w.replace(/.$/, "");
      else if (re4.test(w)) w = w + "e";
    }
  }

  // Step 1c
  re = /^(.+?)y$/;
  if (re.test(w)) {
    const fp = re.exec(w) as RegExpExecArray;
    stemPart = fp[1] as string;
    re = new RegExp(S_V.source);
    if (re.test(stemPart)) w = stemPart + "i";
  }

  // Step 2
  re = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
  if (re.test(w)) {
    const fp = re.exec(w) as RegExpExecArray;
    stemPart = fp[1] as string;
    re = new RegExp(MGR0.source);
    if (re.test(stemPart)) w = stemPart + step2list[fp[2] as string];
  }

  // Step 3
  re = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
  if (re.test(w)) {
    const fp = re.exec(w) as RegExpExecArray;
    stemPart = fp[1] as string;
    re = new RegExp(MGR0.source);
    if (re.test(stemPart)) w = stemPart + step3list[fp[2] as string];
  }

  // Step 4
  re = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
  re2 = /^(.+?)(s|t)(ion)$/;
  if (re.test(w)) {
    const fp = re.exec(w) as RegExpExecArray;
    stemPart = fp[1] as string;
    re = new RegExp(MGR1.source);
    if (re.test(stemPart)) w = stemPart;
  } else if (re2.test(w)) {
    const fp = re2.exec(w) as RegExpExecArray;
    stemPart = (fp[1] as string) + (fp[2] as string);
    re2 = new RegExp(MGR1.source);
    if (re2.test(stemPart)) w = stemPart;
  }

  // Step 5
  re = /^(.+?)e$/;
  if (re.test(w)) {
    const fp = re.exec(w) as RegExpExecArray;
    stemPart = fp[1] as string;
    re = new RegExp(MGR1.source);
    re2 = new RegExp(MEQ1.source);
    re3 = new RegExp("^" + consSeq + vowel + "[^aeiouwxy]$");
    if (re.test(stemPart) || (re2.test(stemPart) && !re3.test(stemPart))) w = stemPart;
  }
  re = /ll$/;
  re2 = new RegExp(MGR1.source);
  if (re.test(w) && re2.test(w)) w = w.replace(/.$/, "");

  if (firstch === "y") w = "y" + w.slice(1);
  return w;
}

/**
 * Split text into lowercased, stemmed, stopword-filtered terms. Numbers pass
 * through unstemmed. Single characters are dropped (no retrieval value). This is
 * the one tokenizer both indexing and querying use, so document and query terms
 * always land in the same space.
 */
export function tokenize(text: string): string[] {
  const matched = text.toLowerCase().match(/[a-z0-9]+/g);
  if (!matched) return [];
  const out: string[] = [];
  for (const tok of matched) {
    if (tok.length < 2) continue;
    if (STOPWORDS.has(tok)) continue;
    out.push(/^[a-z]+$/.test(tok) ? stem(tok) : tok);
  }
  return out;
}

// Standard BM25 parameters.
const K1 = 1.2;
const B = 0.75;

interface Doc {
  chunk: Chunk;
  /** Token count (document length) for BM25 length normalization. */
  len: number;
  /** Term → frequency within this chunk. */
  tf: Map<string, number>;
}

export class LexicalIndex implements LexicalSearch {
  /** chunk.id → indexed doc. */
  private readonly docs = new Map<string, Doc>();
  /** term → set of chunk ids containing it (for df + candidate gathering). */
  private readonly postings = new Map<string, Set<string>>();
  private totalLen = 0;

  /** Number of indexed chunks. */
  get size(): number {
    return this.docs.size;
  }

  clear(): void {
    this.docs.clear();
    this.postings.clear();
    this.totalLen = 0;
  }

  /** Index a batch of chunks. The heading is folded into the token stream so a
   *  query for a section title can surface its body. */
  add(chunks: readonly Chunk[]): void {
    for (const chunk of chunks) {
      const text = chunk.heading ? `${chunk.heading}\n${chunk.text}` : chunk.text;
      const tokens = tokenize(text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.docs.set(chunk.id, { chunk, len: tokens.length, tf });
      this.totalLen += tokens.length;
      for (const term of tf.keys()) {
        let set = this.postings.get(term);
        if (!set) {
          set = new Set<string>();
          this.postings.set(term, set);
        }
        set.add(chunk.id);
      }
    }
  }

  /** Drop every chunk belonging to one note (deleted/renamed-away on disk). */
  removeNote(notePath: string): void {
    for (const [id, doc] of this.docs) {
      if (doc.chunk.notePath !== notePath) continue;
      this.docs.delete(id);
      this.totalLen -= doc.len;
      for (const term of doc.tf.keys()) {
        const set = this.postings.get(term);
        if (!set) continue;
        set.delete(id);
        if (set.size === 0) this.postings.delete(term);
      }
    }
  }

  /** Swap one note's chunks (incremental re-index after an edit). Keeps the
   *  lexical index in step with the vector index — both must move together or
   *  retrieval drifts silently. */
  replaceNote(notePath: string, chunks: readonly Chunk[]): void {
    this.removeNote(notePath);
    this.add(chunks);
  }

  /**
   * Top-k chunks by BM25. Its OWN relevance gate (7A): a positive BM25 means the
   * chunk shares at least one non-stopword term with the query, so we keep score
   * > 0 and drop the rest. This is NOT the cosine `minScore` (different scale) —
   * an off-topic query shares no terms, yields no candidates, and the caller
   * honestly reports "no matches" rather than injecting noise.
   */
  search(query: string, k: number): ScoredChunk[] {
    const N = this.docs.size;
    if (N === 0) return [];
    const qTerms = [...new Set(tokenize(query))];
    if (qTerms.length === 0) return [];

    const avgdl = this.totalLen / N;
    const candidates = new Set<string>();
    for (const t of qTerms) {
      const set = this.postings.get(t);
      if (set) for (const id of set) candidates.add(id);
    }

    const scored: ScoredChunk[] = [];
    for (const id of candidates) {
      const doc = this.docs.get(id) as Doc;
      let score = 0;
      for (const t of qTerms) {
        const f = doc.tf.get(t);
        if (!f) continue;
        const df = (this.postings.get(t) as Set<string>).size;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const denom = f + K1 * (1 - B + (B * doc.len) / avgdl);
        score += (idf * (f * (K1 + 1))) / denom;
      }
      if (score > 0) scored.push({ ...doc.chunk, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}
