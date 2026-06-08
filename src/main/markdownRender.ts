import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import type { RenderNode, RenderTag } from "../shared/render.js";

/**
 * Glass-box markdown rendering (5A). markdown-it is used as a TOKENIZER ONLY
 * (html:false): we walk its token tree and emit a restricted RenderNode AST. Raw
 * HTML tokens are carried as TEXT, links are scheme-allowlisted, and wikilinks
 * become routed-click nodes — so the renderer never needs (and never gets) an
 * innerHTML path. Untrusted note/AI content cannot execute.
 */

/** Schemes a real <a href> may use. Everything else becomes inert text. */
const SAFE_LINK_SCHEME = /^(https?:|mailto:)/i;

const ALLOWED_TAGS: Record<string, RenderTag> = {
  p: "p",
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  h5: "h5",
  h6: "h6",
  ul: "ul",
  ol: "ol",
  li: "li",
  blockquote: "blockquote",
  pre: "pre",
  code: "code",
  em: "em",
  strong: "strong",
  del: "del",
  s: "del",
};

interface WikilinkMeta {
  target: string;
  heading: string;
  alias: string;
}

/** A markdown-it inline rule that turns [[target#heading|alias]] into a token. */
function wikilinkRule(state: { src: string; pos: number; push: (type: string, tag: string, nesting: number) => Token }, silent: boolean): boolean {
  const { src, pos } = state;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) {
    return false; // not "[["
  }
  const end = src.indexOf("]]", pos + 2);
  if (end < 0) return false;
  const inner = src.slice(pos + 2, end);
  // Empty or containing a stray "[" (nested brackets) → not a simple wikilink.
  if (inner.length === 0 || inner.includes("[")) return false;

  if (!silent) {
    let left = inner;
    let alias = "";
    const pipe = inner.indexOf("|");
    if (pipe >= 0) {
      left = inner.slice(0, pipe);
      alias = inner.slice(pipe + 1);
    }
    let target = left;
    let heading = "";
    const hash = left.indexOf("#");
    if (hash >= 0) {
      target = left.slice(0, hash);
      heading = left.slice(hash + 1);
    }
    const token = state.push("wikilink", "", 0);
    token.meta = {
      target: target.trim(),
      heading: heading.trim(),
      alias: alias.trim(),
    } satisfies WikilinkMeta;
  }
  state.pos = end + 2;
  return true;
}

function makeMd(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
  // Register before 'link' so "[[" is consumed as a wikilink, not a link.
  md.inline.ruler.before("link", "wikilink", wikilinkRule as never);
  return md;
}

const md = makeMd();

function text(value: string): RenderNode {
  return { t: "text", value };
}

function el(tag: RenderTag, children: RenderNode[]): RenderNode {
  return { t: "el", tag, children };
}

/** Walk an inline token's children into RenderNodes. */
function renderInline(
  children: Token[] | null,
  isKnownNote?: (target: string) => boolean
): RenderNode[] {
  if (!children) return [];
  const root: RenderNode[] = [];
  const stack: RenderNode[][] = [root];
  const top = (): RenderNode[] => stack[stack.length - 1] as RenderNode[];
  const openEl = (tag: RenderTag, extra: Partial<Extract<RenderNode, { t: "el" }>> = {}): void => {
    const node: RenderNode = { t: "el", tag, children: [], ...extra };
    top().push(node);
    stack.push(node.children);
  };
  const close = (): void => {
    if (stack.length > 1) stack.pop();
  };

  for (const tok of children) {
    switch (tok.type) {
      case "text":
        top().push(text(tok.content));
        break;
      case "softbreak":
        top().push(text(" "));
        break;
      case "hardbreak":
        top().push({ t: "br" });
        break;
      case "code_inline":
        top().push(el("code", [text(tok.content)]));
        break;
      case "strong_open":
        openEl("strong");
        break;
      case "em_open":
        openEl("em");
        break;
      case "s_open":
        openEl("del");
        break;
      case "strong_close":
      case "em_close":
      case "s_close":
        close();
        break;
      case "link_open": {
        const href = tok.attrGet("href") ?? "";
        if (SAFE_LINK_SCHEME.test(href)) {
          openEl("a", { href });
        } else {
          // javascript:/data:/relative/etc → render inert (text only, no href).
          openEl("span");
        }
        break;
      }
      case "link_close":
        close();
        break;
      case "image":
        // Render images as their alt text — never an <img> (no src/onerror vector).
        top().push(text(tok.content));
        break;
      case "wikilink": {
        const meta = tok.meta as WikilinkMeta;
        const display = meta.alias || meta.target + (meta.heading ? "#" + meta.heading : "");
        const targetRef = meta.target + (meta.heading ? "#" + meta.heading : "");
        const node: Extract<RenderNode, { t: "el" }> = {
          t: "el",
          tag: "a",
          children: [text(display)],
          wikilink: targetRef,
        };
        if (isKnownNote && !isKnownNote(meta.target)) node.unresolved = true;
        top().push(node);
        break;
      }
      case "html_inline":
        // Raw inline HTML is TEXT, never markup (the core XSS guarantee).
        top().push(text(tok.content));
        break;
      default:
        // Unknown inline token: fall back to its text content if any.
        if (tok.content) top().push(text(tok.content));
        break;
    }
  }
  return root;
}

/**
 * Render markdown to the restricted RenderNode AST. `isKnownNote` (optional)
 * lets the caller mark wikilinks whose target note does not exist.
 */
export function renderMarkdown(
  source: string,
  isKnownNote?: (target: string) => boolean
): RenderNode[] {
  const tokens = md.parse(source, {});
  const root: RenderNode[] = [];
  const stack: RenderNode[][] = [root];
  const top = (): RenderNode[] => stack[stack.length - 1] as RenderNode[];

  for (const tok of tokens) {
    if (tok.type === "inline") {
      for (const n of renderInline(tok.children, isKnownNote)) top().push(n);
      continue;
    }
    if (tok.type === "hr") {
      top().push({ t: "hr" });
      continue;
    }
    if (tok.type === "fence" || tok.type === "code_block") {
      top().push(el("pre", [el("code", [text(tok.content)])]));
      continue;
    }
    if (tok.type === "html_block") {
      // Raw HTML block → a paragraph of TEXT (never markup).
      top().push(el("p", [text(tok.content)]));
      continue;
    }

    if (tok.nesting === 1) {
      const tag = ALLOWED_TAGS[tok.tag];
      if (tag) {
        const node = el(tag, []);
        top().push(node);
        stack.push((node as Extract<RenderNode, { t: "el" }>).children);
      } else {
        // Unknown opening tag: push a transparent group so closes stay balanced.
        const node = el("span", []);
        top().push(node);
        stack.push((node as Extract<RenderNode, { t: "el" }>).children);
      }
    } else if (tok.nesting === -1) {
      if (stack.length > 1) stack.pop();
    }
  }
  return root;
}
