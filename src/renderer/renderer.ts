import type { ConflictResolution, FileNode } from "../shared/ipc.js";
import type {
  ChatMessage,
  GroundingMeta,
  GroundingSource,
  GroundingUnavailableReason,
  ProviderId,
  SafeError,
} from "../shared/ai.js";
import type { ChatSummary } from "../shared/chat.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const statusBar = $<HTMLDivElement>("status");

function setStatus(text: string): void {
  statusBar.textContent = text;
}

// ---------------------------------------------------------------------------
// Vault sidebar: current vault header (open/create) + collapsible file tree.
// ---------------------------------------------------------------------------

const collapseBtn = $<HTMLButtonElement>("collapse-side");
const vaultNameEl = $<HTMLSpanElement>("vault-name");
const vaultMenuBtn = $<HTMLButtonElement>("vault-menu");
const vaultActions = $<HTMLDivElement>("vault-actions");
const openVaultBtn = $<HTMLButtonElement>("open-vault");
const createVaultBtn = $<HTMLButtonElement>("create-vault");
const fileTreeEl = $<HTMLDivElement>("file-tree");
const vaultModal = $<HTMLDivElement>("vault-modal");
const vaultModalClose = $<HTMLButtonElement>("vault-modal-close");
const modalOpenVault = $<HTMLButtonElement>("modal-open-vault");
const modalCreateVault = $<HTMLButtonElement>("modal-create-vault");

// First-launch popup: shown automatically when no vault is set yet, and the
// user can dismiss it (× or backdrop) to look around without choosing one.
function showVaultModal(): void {
  vaultModal.hidden = false;
}
function hideVaultModal(): void {
  vaultModal.hidden = true;
}
vaultModalClose.addEventListener("click", () => hideVaultModal());
vaultModal.addEventListener("click", (e) => {
  if (e.target === vaultModal) hideVaultModal();
});
modalOpenVault.addEventListener("click", async () => {
  const info = await window.secondBrain.vaultChoose();
  if (info) {
    hideVaultModal();
    setStatus(`Opened vault: ${info.name}`);
    await refreshVault();
  }
});
modalCreateVault.addEventListener("click", async () => {
  const info = await window.secondBrain.vaultCreate();
  if (info) {
    hideVaultModal();
    setStatus(`Created vault: ${info.name}`);
    await refreshVault();
  }
});

function closePopovers(): void {
  vaultActions.hidden = true;
  chatListPop.hidden = true;
}
// Any outside click dismisses the open popovers; the toggles below
// stopPropagation so they don't immediately re-close themselves.
document.addEventListener("click", () => closePopovers());

collapseBtn.addEventListener("click", () =>
  document.body.classList.toggle("side-collapsed")
);

// ---------------------------------------------------------------------------
// Light / dark theme. A manual toggle that persists (localStorage). Until the
// user picks explicitly, we follow the OS (prefers-color-scheme) live. The CSS
// already renders system-dark before this script runs, so there's no flash.
// ---------------------------------------------------------------------------

const themeToggle = $<HTMLButtonElement>("theme-toggle");
const THEME_KEY = "sb.theme";
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

type Theme = "light" | "dark";

function resolvedTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return systemDark.matches ? "dark" : "light";
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  // ◐ = currently light (click for dark); ◑ = currently dark (click for light).
  themeToggle.textContent = theme === "dark" ? "◑" : "◐";
  themeToggle.title =
    theme === "dark" ? "Switch to light" : "Switch to dark";
}

applyTheme(resolvedTheme());

themeToggle.addEventListener("click", () => {
  const next: Theme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

// While the user hasn't chosen explicitly, track the OS preference.
systemDark.addEventListener("change", () => {
  if (!localStorage.getItem(THEME_KEY)) applyTheme(resolvedTheme());
});

vaultMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  chatListPop.hidden = true;
  vaultActions.hidden = !vaultActions.hidden;
});

openVaultBtn.addEventListener("click", async () => {
  const info = await window.secondBrain.vaultChoose();
  vaultActions.hidden = true;
  if (info) {
    setStatus(`Opened vault: ${info.name}`);
    await refreshVault();
  }
});

createVaultBtn.addEventListener("click", async () => {
  const info = await window.secondBrain.vaultCreate();
  vaultActions.hidden = true;
  if (info) {
    setStatus(`Created vault: ${info.name}`);
    await refreshVault();
  }
});

async function refreshVault(): Promise<void> {
  const info = await window.secondBrain.vaultInfo();
  vaultNameEl.textContent = info.name ?? "No vault";
  if (!info.root) showVaultModal();
  await refreshTree();
  await refreshGroundingStatus();
}

async function refreshTree(): Promise<void> {
  const nodes = await window.secondBrain.vaultFiles();
  fileTreeEl.replaceChildren();
  if (nodes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = "No notes yet";
    fileTreeEl.appendChild(empty);
    return;
  }
  for (const node of nodes) fileTreeEl.appendChild(renderNode(node, 0));
}

function renderNode(node: FileNode, depth: number): HTMLElement {
  if (node.type === "dir") {
    const wrap = document.createElement("div");
    const row = document.createElement("div");
    row.className = "tree-row dir";
    row.style.paddingLeft = `${8 + depth * 14}px`;
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = "▸";
    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = node.name;
    row.append(caret, name);

    const children = document.createElement("div");
    children.className = "tree-children";
    children.hidden = true;
    for (const child of node.children ?? [])
      children.appendChild(renderNode(child, depth + 1));

    row.addEventListener("click", () => {
      children.hidden = !children.hidden;
      caret.classList.toggle("open", !children.hidden);
    });
    wrap.append(row, children);
    return wrap;
  }

  const row = document.createElement("div");
  row.className = "tree-row file";
  row.dataset.path = node.path;
  row.style.paddingLeft = `${8 + depth * 14}px`;
  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = node.name.replace(/\.(md|markdown)$/i, "");
  row.appendChild(name);
  row.addEventListener("click", () => void openNoteByPath(node.path));
  return row;
}

function highlightTreeRow(path: string): void {
  for (const r of Array.from(
    fileTreeEl.querySelectorAll(".tree-row.file.active")
  ))
    r.classList.remove("active");
  const match = fileTreeEl.querySelector<HTMLElement>(
    `.tree-row.file[data-path="${CSS.escape(path)}"]`
  );
  match?.classList.add("active");
}

/**
 * Open a note in the editor by absolute path. Shared by the file tree and by
 * provenance sidenotes (clicking a source under a grounded answer). Flushes any
 * pending edits first, then highlights the matching tree row if it's visible.
 */
async function openNoteByPath(path: string): Promise<void> {
  // Flush any pending edits on the note we're leaving before switching.
  if (currentPath && !conflicted) await doSave();
  const result = await window.secondBrain.openPath(path);
  if (!result) {
    setStatus("Couldn't open that note.");
    return;
  }
  showConflict(false);
  loadIntoEditor(result.path, result.text);
  highlightTreeRow(result.path);
}

// ---------------------------------------------------------------------------
// Editor: autosaves (debounced + on blur). A live save-state indicator reports
// Saved / Saving… / Unsaved / Conflict so the user always knows where they
// stand. Conflicts still surface the panel and pause autosave until resolved.
// ---------------------------------------------------------------------------

const editor = $<HTMLTextAreaElement>("editor");
const pathLabel = $<HTMLSpanElement>("path");
const saveStateEl = $<HTMLSpanElement>("save-state");
const conflictPanel = $<HTMLElement>("conflict");

let currentPath: string | null = null;
let savedText = ""; // last text known to be on disk
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
let conflicted = false;

const SAVE_DEBOUNCE_MS = 700;

type SaveKind = "" | "saved" | "saving" | "dirty" | "conflict" | "error";
function setSaveState(kind: SaveKind, msg?: string): void {
  saveStateEl.className = `save-state ${kind}`;
  const labels: Record<SaveKind, string> = {
    "": "",
    saved: "Saved",
    saving: "Saving…",
    dirty: "Unsaved changes",
    conflict: "Conflict — resolve below",
    error: "Couldn't save",
  };
  saveStateEl.textContent = msg ?? labels[kind];
}

function showConflict(show: boolean): void {
  conflictPanel.classList.toggle("show", show);
}

function loadIntoEditor(path: string, text: string): void {
  currentPath = path;
  editor.value = text;
  editor.disabled = false;
  pathLabel.textContent = path;
  savedText = text;
  conflicted = false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  setSaveState("saved");
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void doSave(), SAVE_DEBOUNCE_MS);
}

async function doSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!currentPath || saving || conflicted) return;
  const text = editor.value;
  if (text === savedText) {
    setSaveState("saved");
    return;
  }
  saving = true;
  setSaveState("saving");
  const res = await window.secondBrain.save(currentPath, text);
  saving = false;
  switch (res.status) {
    case "saved":
      savedText = text;
      // If the user kept typing during the await, the editor is dirty again.
      if (editor.value !== savedText) {
        setSaveState("dirty");
        scheduleSave();
      } else {
        setSaveState("saved");
      }
      break;
    case "conflict":
      conflicted = true;
      showConflict(true);
      setSaveState("conflict");
      break;
    case "deleted":
      setSaveState("error", "Note deleted on disk");
      break;
    case "renamed":
      setSaveState("error", "Note replaced on disk — reopen it");
      break;
    case "error":
      setSaveState("error", `Couldn't save: ${res.message}`);
      break;
  }
}

editor.addEventListener("input", () => {
  if (!currentPath || conflicted) return;
  setSaveState("dirty");
  scheduleSave();
});
editor.addEventListener("blur", () => {
  if (currentPath && !conflicted) void doSave();
});

async function resolveWith(resolution: ConflictResolution): Promise<void> {
  if (!currentPath) return;
  const res = await window.secondBrain.resolve(currentPath, resolution);
  switch (res.status) {
    case "keep-mine":
      editor.value = res.text;
      savedText = res.text;
      conflicted = false;
      showConflict(false);
      setSaveState("saved");
      setStatus("Kept your version.");
      break;
    case "take-theirs":
      editor.value = res.text;
      savedText = res.text;
      conflicted = false;
      showConflict(false);
      setSaveState("saved");
      setStatus("Took the on-disk version.");
      break;
    case "keep-both":
      editor.value = res.theirsText;
      savedText = res.theirsText;
      conflicted = false;
      showConflict(false);
      setSaveState("saved");
      setStatus(`Kept both. Your version saved to: ${res.minePath}`);
      await refreshTree();
      break;
    case "error":
      setStatus(`Couldn't resolve: ${res.message}`);
      break;
  }
}

$<HTMLButtonElement>("keep-mine").addEventListener("click", () =>
  resolveWith("keep-mine")
);
$<HTMLButtonElement>("take-theirs").addEventListener("click", () =>
  resolveWith("take-theirs")
);
$<HTMLButtonElement>("keep-both").addEventListener("click", () =>
  resolveWith("keep-both")
);

// ---------------------------------------------------------------------------
// AI cockpit. Transcripts are durably persisted per chat (D14): one append-only
// file per chatId in the main process, OUTSIDE the vault. The renderer holds
// only the active chat's plain transcript.
// ---------------------------------------------------------------------------

const providerBar = $<HTMLDivElement>("provider");
const providerButtons = Array.from(
  providerBar.querySelectorAll<HTMLButtonElement>("button[data-provider]")
);
const modelSelect = $<HTMLSelectElement>("model");
const settingsToggle = $<HTMLButtonElement>("settings-toggle");
const settingsPanel = $<HTMLElement>("settings");
const keyState = $<HTMLDivElement>("key-state");
const keyInput = $<HTMLInputElement>("key-input");
const keySave = $<HTMLButtonElement>("key-save");
const messagesEl = $<HTMLDivElement>("messages");
const promptEl = $<HTMLTextAreaElement>("prompt");
const sendBtn = $<HTMLButtonElement>("send");
const indexBtn = $<HTMLButtonElement>("index-btn");
const groundState = $<HTMLSpanElement>("ground-state");
const groundDot = $<HTMLSpanElement>("ground-dot");
const chatSwitchBtn = $<HTMLButtonElement>("chat-switch");
const currentChatTitleEl = $<HTMLSpanElement>("current-chat-title");
const chatListPop = $<HTMLDivElement>("chat-list");
const newChatBtn = $<HTMLButtonElement>("new-chat");

// Curated model list per provider. First entry is the default selection.
// Edit here to add/remove models — the dropdown is built from this.
interface ModelOption {
  id: string;
  label: string;
}
const MODELS: Record<ProviderId, ModelOption[]> = {
  anthropic: [
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "gpt-4o-mini", label: "GPT-4o mini" },
    { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
    { id: "o1", label: "o1" },
    { id: "o1-mini", label: "o1-mini" },
  ],
};

// Rebuild the dropdown for a provider; the browser selects the first option,
// which is our intended default.
function populateModels(id: ProviderId): void {
  modelSelect.replaceChildren();
  for (const m of MODELS[id]) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    modelSelect.appendChild(opt);
  }
}

// The active chat: its id and the running transcript sent to the gateway each
// turn (multi-turn context). Switching chats swaps both out.
let currentChatId: string | null = null;
const transcript: ChatMessage[] = [];
let chatSummaries: ChatSummary[] = [];
let configured: ProviderId[] = [];
let sending = false;
let providerId: ProviderId = "anthropic";

function currentProvider(): ProviderId {
  return providerId;
}

// Segmented provider control. Selecting a provider updates the .on highlight,
// rebuilds the model dropdown for that provider, and refreshes the key status.
function setProvider(id: ProviderId): void {
  providerId = id;
  for (const btn of providerButtons) {
    btn.classList.toggle("on", btn.dataset.provider === id);
  }
  populateModels(id);
  void refreshAiStatus();
}

for (const btn of providerButtons) {
  btn.addEventListener("click", () => {
    const id = btn.dataset.provider as ProviderId;
    if (id !== providerId) setProvider(id);
  });
}

function humanError(err: SafeError): string {
  switch (err.variant) {
    case "AuthFailed":
      return 'No usable API key for this provider. Click "Key" to add one.';
    case "QuotaExceeded":
      return "This provider reports the account is out of credit/quota.";
    case "RateLimited":
      return "Rate limited by the provider. Try again in a moment.";
    case "Timeout":
      return "The request timed out. Check your connection and retry.";
    case "Refusal":
      return "The model declined to answer this request.";
    case "BadResponse":
      return "The provider returned an unexpected response.";
    case "MalformedProposal":
      return "The model tried to edit a note but its proposal was malformed. Nothing was changed.";
  }
}

// D12: every answer carries a visible grounding badge — green when it used
// vault context, amber ("answering without vault context") when it did not,
// so the user is never fooled into thinking an answer reflects their notes.
const UNGROUNDED_REASON: Record<GroundingUnavailableReason, string> = {
  off: "grounding off",
  "not-indexed": "vault not indexed yet",
  "empty-index": "no notes indexed",
  "embed-failed": "vault search failed",
  "no-matches": "no relevant notes found",
};

function makeBadge(grounding: GroundingMeta): HTMLSpanElement {
  const badge = document.createElement("span");
  if (grounding.grounded) {
    const names = uniqueNoteNames(grounding.sources).join(", ");
    badge.className = "badge grounded";
    badge.textContent = `grounded · ${names}`;
  } else {
    badge.className = "badge ungrounded";
    badge.textContent = `answering without vault context (${UNGROUNDED_REASON[grounding.reason]})`;
  }
  return badge;
}

// ---------------------------------------------------------------------------
// Provenance sidenotes. A grounded answer cites its sources inline with [n]
// markers (see buildContext). We render each [n] as a clickable superscript and
// list the cited notes as sidenotes beneath the answer — click either to open
// the source note in the editor. This is the product's whole promise made
// visible: the AI shows its receipts, and you can verify them.
// ---------------------------------------------------------------------------

const CITE_RE = /\[(\d+)\]/g;

/** A note's display name: the filename without the .md extension. */
function noteName(notePath: string): string {
  const base = notePath.split("/").pop() ?? notePath;
  return base.replace(/\.(md|markdown)$/i, "");
}

/** Unique note display names, preserving first-seen order. */
function uniqueNoteNames(sources: readonly GroundingSource[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sources) {
    if (seen.has(s.notePath)) continue;
    seen.add(s.notePath);
    out.push(noteName(s.notePath));
  }
  return out;
}

/** A clickable sidenote row: number chip + source name → opens the note. */
function makeSidenote(n: number, source: GroundingSource): HTMLButtonElement {
  const row = document.createElement("button");
  row.className = "sidenote";
  row.dataset.path = source.notePath;

  const num = document.createElement("span");
  num.className = "sn-num";
  num.textContent = String(n);

  const src = document.createElement("span");
  src.className = "sn-src";
  src.textContent = source.heading
    ? `${noteName(source.notePath)} › ${source.heading}`
    : noteName(source.notePath);

  row.append(num, src);
  row.addEventListener("click", () => void openNoteByPath(source.notePath));
  return row;
}

/**
 * Render a grounded assistant answer: the text with inline [n] markers turned
 * into clickable citations, followed by a sidenote list of the cited sources.
 * Built entirely from text nodes / elements (never innerHTML) so it stays
 * XSS-safe — the model's text is untrusted.
 */
function renderGroundedAnswer(
  el: HTMLElement,
  text: string,
  sources: readonly GroundingSource[]
): void {
  const cited: number[] = []; // citation numbers in first-seen order
  const inRange = (n: number): boolean => n >= 1 && n <= sources.length;

  let last = 0;
  for (const m of text.matchAll(CITE_RE)) {
    const idx = m.index ?? 0;
    const n = Number(m[1]);
    // Plain text before this marker.
    if (idx > last) el.appendChild(document.createTextNode(text.slice(last, idx)));
    if (inRange(n)) {
      const sup = document.createElement("sup");
      sup.className = "cite";
      sup.textContent = String(n);
      const s = sources[n - 1]!;
      sup.title = noteName(s.notePath);
      sup.addEventListener("click", () => void openNoteByPath(s.notePath));
      el.appendChild(sup);
      if (!cited.includes(n)) cited.push(n);
    } else {
      // Out-of-range marker: keep it literally, don't silently drop content.
      el.appendChild(document.createTextNode(m[0]));
    }
    last = idx + m[0].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));

  // Sidenotes: the cited sources, or — if the model cited nothing inline — all
  // sources, so provenance is always shown.
  const shown = cited.length > 0 ? cited : sources.map((_, i) => i + 1);

  const box = document.createElement("div");
  box.className = "sidenotes";
  const head = document.createElement("div");
  head.className = "sn-head";
  const noteCount = uniqueNoteNames(shown.map((n) => sources[n - 1]!)).length;
  head.textContent = `Grounded in ${noteCount} note${noteCount === 1 ? "" : "s"}`;
  box.appendChild(head);
  for (const n of shown) box.appendChild(makeSidenote(n, sources[n - 1]!));
  el.appendChild(box);
}

// A transient "assistant is typing" bubble shown in the conversation itself
// while the (slow) model call is in flight — the bottom status strip is too far
// from the chat to read as live feedback. Removed before the real answer lands.
let thinkingEl: HTMLDivElement | null = null;

function showThinking(): void {
  hideThinking();
  const el = document.createElement("div");
  el.className = "msg assistant thinking";
  const dots = document.createElement("span");
  dots.className = "typing";
  for (let i = 0; i < 3; i++) dots.appendChild(document.createElement("span"));
  el.appendChild(dots);
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  thinkingEl = el;
}

function hideThinking(): void {
  thinkingEl?.remove();
  thinkingEl = null;
}

function appendMessage(
  role: "user" | "assistant" | "error",
  text: string,
  extras?: {
    usage?: { inputTokens: number; outputTokens: number };
    grounding?: GroundingMeta;
  }
): void {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  const g = extras?.grounding;
  if (role === "assistant" && g?.grounded && g.sources.length > 0) {
    // Grounded answers render inline citations + provenance sidenotes instead
    // of a flat badge (the sidenotes carry the "grounded in N notes" header).
    renderGroundedAnswer(el, text, g.sources);
  } else {
    el.textContent = text;
    if (g) el.appendChild(makeBadge(g));
  }
  if (extras?.usage) {
    const u = document.createElement("span");
    u.className = "usage";
    u.textContent = `${extras.usage.inputTokens} in / ${extras.usage.outputTokens} out tokens`;
    el.appendChild(u);
  }
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---- Multi-chat list (D14) — a dropdown in the chat header; rename inline ----

function activeTitle(): string {
  const a = chatSummaries.find((c) => c.id === currentChatId);
  return a ? a.title : "New chat";
}

function renderChatList(): void {
  chatListPop.replaceChildren();
  for (const chat of chatSummaries) {
    const item = document.createElement("div");
    item.className = chat.id === currentChatId ? "chat-item active" : "chat-item";

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = chat.title;
    title.title = chat.title;
    item.appendChild(title);

    // Dedicated rename affordance. stopPropagation keeps the item's click
    // (select + close popover) from firing, so the inline input stays visible.
    const ren = document.createElement("button");
    ren.className = "ren";
    ren.textContent = "✎";
    ren.title = "Rename chat";
    ren.addEventListener("click", (e) => {
      e.stopPropagation();
      startRename(chat, title, item);
    });
    item.appendChild(ren);

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "×";
    del.title = "Delete chat";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      void removeChat(chat.id);
    });
    item.appendChild(del);

    item.addEventListener("click", () => {
      chatListPop.hidden = true;
      void selectChat(chat.id);
    });
    chatListPop.appendChild(item);
  }
  currentChatTitleEl.textContent = activeTitle();
}

// Inline rename: swap the title for an input; Enter / blur commits, Esc cancels.
function startRename(
  chat: ChatSummary,
  titleEl: HTMLSpanElement,
  item: HTMLElement
): void {
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = chat.title;
  input.addEventListener("click", (e) => e.stopPropagation());
  item.replaceChild(input, titleEl);
  input.focus();
  input.select();

  let done = false;
  const commit = async (save: boolean): Promise<void> => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== chat.title) {
      await window.secondBrain.chatRename(chat.id, name);
    }
    await refreshChatList();
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void commit(true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      void commit(false);
    }
  });
  input.addEventListener("blur", () => void commit(true));
}

async function refreshChatList(): Promise<void> {
  chatSummaries = await window.secondBrain.chatList();
  renderChatList();
}

/** Load a chat's persisted transcript into the active view. */
async function selectChat(id: string): Promise<void> {
  const session = await window.secondBrain.chatLoad(id);
  if (!session) {
    await refreshChatList();
    return;
  }
  currentChatId = id;
  transcript.length = 0;
  messagesEl.replaceChildren();
  for (const m of session.messages) {
    transcript.push({ role: m.role, content: m.content });
    appendMessage(m.role, m.content, m.grounding ? { grounding: m.grounding } : undefined);
  }
  await refreshChatList();
  promptEl.focus();
}

async function newChat(): Promise<void> {
  const summary = await window.secondBrain.chatCreate();
  currentChatId = summary.id;
  transcript.length = 0;
  messagesEl.replaceChildren();
  await refreshChatList();
  promptEl.focus();
}

async function removeChat(id: string): Promise<void> {
  await window.secondBrain.chatDelete(id);
  if (id === currentChatId) {
    const remaining = await window.secondBrain.chatList();
    if (remaining[0]) await selectChat(remaining[0].id);
    else await newChat();
  } else {
    await refreshChatList();
  }
}

newChatBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  chatListPop.hidden = true;
  void newChat();
});

chatSwitchBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  vaultActions.hidden = true;
  chatListPop.hidden = !chatListPop.hidden;
});

// Grounding is ALWAYS ON — there is no toggle. This status line just reports,
// calmly, whether the vault is connected so answers can use it. Three states:
//   indexing → "Indexing your vault…"           (dot off, button hidden)
//   ready    → "Vault connected · N notes"       (dot green, button = "Re-index")
//   first run→ first-run CTA + prominent button  (dot off, button = "Index your vault")
async function refreshGroundingStatus(): Promise<void> {
  const s = await window.secondBrain.aiGroundingStatus();
  if (s.indexing) {
    groundDot.classList.remove("on");
    groundState.textContent = "Indexing your vault…";
    indexBtn.hidden = true;
  } else if (s.ready) {
    groundDot.classList.add("on");
    groundState.textContent = `Vault connected · ${s.notes} notes`;
    indexBtn.hidden = false;
    indexBtn.classList.remove("cta");
    indexBtn.textContent = "Re-index";
  } else {
    groundDot.classList.remove("on");
    groundState.textContent = "Index your vault so answers can use your notes";
    indexBtn.hidden = false;
    indexBtn.classList.add("cta");
    indexBtn.textContent = "Index your vault";
  }
  // The status line truncates in the narrow chat column; mirror it into a
  // tooltip so the full text is readable on hover.
  groundState.title = groundState.textContent ?? "";
}

indexBtn.addEventListener("click", async () => {
  indexBtn.disabled = true;
  groundDot.classList.remove("on");
  groundState.textContent = "Indexing your vault… (first run downloads the local model)";
  indexBtn.hidden = true;
  const res = await window.secondBrain.aiIndexVault();
  indexBtn.disabled = false;
  if (res.ok) {
    setStatus(`Indexed ${res.notes} notes (${res.chunks} chunks).`);
  } else {
    setStatus(`Indexing failed: ${res.message}`);
  }
  await refreshGroundingStatus();
});

async function refreshAiStatus(): Promise<void> {
  const status = await window.secondBrain.aiStatus();
  configured = status.configured;
  const provider = currentProvider();
  const has = configured.includes(provider);
  if (status.keyStoreState === "locked") {
    keyState.textContent =
      "Key store locked (OS keychain unavailable). Keys can't be saved on this machine.";
  } else if (status.keyStoreState === "tampered") {
    keyState.textContent =
      "Key store file is corrupt. Saving a new key will replace it.";
  } else {
    keyState.textContent = has
      ? `A key is configured for ${provider}.`
      : `No key configured for ${provider}.`;
  }
}

settingsToggle.addEventListener("click", () => {
  settingsPanel.classList.toggle("show");
  if (settingsPanel.classList.contains("show")) void refreshAiStatus();
});

keySave.addEventListener("click", async () => {
  const key = keyInput.value.trim();
  if (!key) return;
  keySave.disabled = true;
  const res = await window.secondBrain.aiSetKey(currentProvider(), key);
  keySave.disabled = false;
  if (res.ok) {
    keyInput.value = "";
    setStatus(`Saved key for ${currentProvider()}.`);
    await refreshAiStatus();
  } else {
    keyState.textContent = `Couldn't save key: ${humanError(res.error)}`;
  }
});

async function send(): Promise<void> {
  const text = promptEl.value.trim();
  if (!text || sending) return;

  // Claim the guard BEFORE any await, so two fast Enter presses can't both get
  // past the check above and double-send (the first message, before a chat
  // exists, awaits newChat()).
  sending = true;
  sendBtn.disabled = true;

  // A chat should always exist by now, but never send into the void.
  if (!currentChatId) await newChat();
  const chatId = currentChatId;
  if (!chatId) {
    sending = false;
    sendBtn.disabled = false;
    return;
  }

  promptEl.value = "";
  autoGrowPrompt();
  transcript.push({ role: "user", content: text });
  appendMessage("user", text);
  // Persist the user turn immediately, before the (slow, fallible) model call,
  // so a crash or quit mid-request never loses what the user typed.
  await window.secondBrain.chatAppend(chatId, {
    role: "user",
    content: text,
    ts: Date.now(),
  });
  await refreshChatList(); // title/order update from the first user message
  setStatus("Thinking…");
  showThinking();

  const res = await window.secondBrain.aiSend(
    {
      model: { provider: currentProvider(), model: modelSelect.value },
      messages: transcript,
    },
    { ground: true }
  );

  hideThinking();
  if (res.ok) {
    transcript.push({ role: "assistant", content: res.response.text });
    const extras: Parameters<typeof appendMessage>[2] = {
      grounding: res.grounding,
    };
    if (res.response.usage) extras.usage = res.response.usage;
    appendMessage("assistant", res.response.text, extras);
    await window.secondBrain.chatAppend(chatId, {
      role: "assistant",
      content: res.response.text,
      ts: Date.now(),
      grounding: res.grounding,
    });
    setStatus("Ready.");
  } else {
    // The user turn was already persisted, so the in-memory transcript keeps it
    // too (memory stays in sync with disk). The error bubble isn't persisted —
    // it's transient UI; the next message simply continues from the saved turn.
    appendMessage("error", humanError(res.error));
    setStatus(`AI error: ${res.error.variant}`);
  }

  sending = false;
  sendBtn.disabled = false;
  promptEl.focus();
}

sendBtn.addEventListener("click", () => void send());

// Grow the composer with its content up to the CSS max-height (then it scrolls).
// rows="1" + max-height alone never expands a textarea; this drives the height.
function autoGrowPrompt(): void {
  promptEl.style.height = "auto";
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 120)}px`;
}

promptEl.addEventListener("input", autoGrowPrompt);

promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
});

// On launch, resume the most recent chat (or start a fresh one if none exist).
async function initChats(): Promise<void> {
  const chats = await window.secondBrain.chatList();
  if (chats[0]) await selectChat(chats[0].id);
  else await newChat();
}

populateModels(providerId);
void refreshAiStatus();
void refreshVault();
void initChats();
