// A restricted, serializable render-AST for the glass-box editor's read view.
// The main process tokenizes markdown (markdown-it, html:false) into this tree;
// the renderer builds DOM from it with createElement + textContent ONLY. Raw
// HTML never appears here — html tokens are carried as TEXT — so the renderer
// has no innerHTML path and untrusted note content can never execute (5A).

/** The closed set of element tags the renderer is allowed to create. */
export type RenderTag =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "ul"
  | "ol"
  | "li"
  | "blockquote"
  | "pre"
  | "code"
  | "em"
  | "strong"
  | "del"
  | "a"
  | "span";

export type RenderNode =
  | { t: "text"; value: string }
  | { t: "br" }
  | { t: "hr" }
  | {
      t: "el";
      tag: RenderTag;
      children: RenderNode[];
      /** Sanitized external href (http/https/mailto only) for an <a>. */
      href?: string;
      /** A wikilink target (the renderer routes the click through IPC, never href). */
      wikilink?: string;
      /** True when a wikilink's target note does not exist (distinct styling). */
      unresolved?: boolean;
    };
