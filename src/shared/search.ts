// Shared shapes for the glass-box backlinks + search surfaces (6A). Plain data,
// safe for the renderer to import.

/** One full-text search hit: the note + a short snippet around the first match. */
export interface SearchHit {
  path: string;
  name: string;
  snippet: string;
}

/** One backlink: a note that links to the currently-open note. */
export interface Backlink {
  path: string;
  name: string;
}
