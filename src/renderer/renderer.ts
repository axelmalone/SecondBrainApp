import type { ConflictResolution } from "../shared/ipc.js";
import type {
  ChatMessage,
  GroundingMeta,
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

const openBtn = $<HTMLButtonElement>("open");
const saveBtn = $<HTMLButtonElement>("save");
const editor = $<HTMLTextAreaElement>("editor");
const pathLabel = $<HTMLSpanElement>("path");
const statusBar = $<HTMLDivElement>("status");
const conflictPanel = $<HTMLElement>("conflict");

let currentPath: string | null = null;

function setStatus(text: string): void {
  statusBar.textContent = text;
}

function showConflict(show: boolean): void {
  conflictPanel.classList.toggle("show", show);
}

function loadIntoEditor(path: string, text: string): void {
  currentPath = path;
  editor.value = text;
  editor.disabled = false;
  saveBtn.disabled = false;
  pathLabel.textContent = path;
}

openBtn.addEventListener("click", async () => {
  const result = await window.secondBrain.open();
  if (!result) return; // cancelled
  showConflict(false);
  loadIntoEditor(result.path, result.text);
  setStatus("Opened.");
});

saveBtn.addEventListener("click", async () => {
  if (!currentPath) return;
  setStatus("Saving…");
  const res = await window.secondBrain.save(currentPath, editor.value);
  switch (res.status) {
    case "saved":
      showConflict(false);
      setStatus("Saved.");
      break;
    case "conflict":
      showConflict(true);
      setStatus("Conflict: this note also changed on disk.");
      break;
    case "deleted":
      setStatus("This note was deleted on disk. Save cancelled.");
      break;
    case "renamed":
      setStatus("This note was replaced on disk. Reopen it to continue.");
      break;
    case "error":
      setStatus(`Couldn't save: ${res.message}`);
      break;
  }
});

async function resolveWith(resolution: ConflictResolution): Promise<void> {
  if (!currentPath) return;
  const res = await window.secondBrain.resolve(currentPath, resolution);
  switch (res.status) {
    case "keep-mine":
      editor.value = res.text;
      showConflict(false);
      setStatus("Kept your version.");
      break;
    case "take-theirs":
      editor.value = res.text;
      showConflict(false);
      setStatus("Took the on-disk version.");
      break;
    case "keep-both":
      editor.value = res.theirsText;
      showConflict(false);
      setStatus(`Kept both. Your version saved to: ${res.minePath}`);
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

const providerSelect = $<HTMLSelectElement>("provider");
const modelInput = $<HTMLInputElement>("model");
const settingsToggle = $<HTMLButtonElement>("settings-toggle");
const settingsPanel = $<HTMLElement>("settings");
const keyState = $<HTMLDivElement>("key-state");
const keyInput = $<HTMLInputElement>("key-input");
const keySave = $<HTMLButtonElement>("key-save");
const messagesEl = $<HTMLDivElement>("messages");
const promptEl = $<HTMLTextAreaElement>("prompt");
const sendBtn = $<HTMLButtonElement>("send");
const groundToggle = $<HTMLInputElement>("ground-toggle");
const indexBtn = $<HTMLButtonElement>("index-btn");
const groundState = $<HTMLSpanElement>("ground-state");
const chatListEl = $<HTMLDivElement>("chat-list");
const newChatBtn = $<HTMLButtonElement>("new-chat");

// Sensible default model per provider; the user can edit it freely.
const DEFAULT_MODEL: Record<ProviderId, string> = {
  anthropic: "claude-sonnet-4-5-20250929",
  openai: "gpt-4o",
};

// The active chat: its id and the running transcript sent to the gateway each
// turn (multi-turn context). Switching chats swaps both out.
let currentChatId: string | null = null;
const transcript: ChatMessage[] = [];
let configured: ProviderId[] = [];
let sending = false;

function currentProvider(): ProviderId {
  return providerSelect.value as ProviderId;
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
    const names = grounding.sources
      .map((s) => s.notePath.split("/").pop() ?? s.notePath)
      .join(", ");
    badge.className = "badge grounded";
    badge.textContent = `grounded · ${grounding.sources.length} note(s): ${names}`;
  } else {
    badge.className = "badge ungrounded";
    badge.textContent = `answering without vault context (${UNGROUNDED_REASON[grounding.reason]})`;
  }
  return badge;
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
  el.textContent = text;
  if (extras?.grounding) el.appendChild(makeBadge(extras.grounding));
  if (extras?.usage) {
    const u = document.createElement("span");
    u.className = "usage";
    u.textContent = `${extras.usage.inputTokens} in / ${extras.usage.outputTokens} out tokens`;
    el.appendChild(u);
  }
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---- Multi-chat list (D14) ----

function renderChatList(chats: ChatSummary[]): void {
  chatListEl.replaceChildren();
  for (const chat of chats) {
    const item = document.createElement("div");
    item.className = chat.id === currentChatId ? "chat-item active" : "chat-item";

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = chat.title;
    item.appendChild(title);

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "×";
    del.title = "Delete chat";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      void removeChat(chat.id);
    });
    item.appendChild(del);

    item.addEventListener("click", () => void selectChat(chat.id));
    chatListEl.appendChild(item);
  }
}

async function refreshChatList(): Promise<void> {
  renderChatList(await window.secondBrain.chatList());
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

newChatBtn.addEventListener("click", () => void newChat());

async function refreshGroundingStatus(): Promise<void> {
  const s = await window.secondBrain.aiGroundingStatus();
  if (s.indexing) {
    groundState.textContent = "indexing…";
  } else if (s.ready) {
    groundState.textContent = `indexed ${s.notes} notes / ${s.chunks} chunks`;
  } else {
    groundState.textContent = "not indexed";
  }
}

indexBtn.addEventListener("click", async () => {
  indexBtn.disabled = true;
  groundState.textContent = "indexing… (first run downloads the local model)";
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

providerSelect.addEventListener("change", () => {
  modelInput.value = DEFAULT_MODEL[currentProvider()];
  void refreshAiStatus();
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

  const res = await window.secondBrain.aiSend(
    {
      model: { provider: currentProvider(), model: modelInput.value.trim() },
      messages: transcript,
    },
    { ground: groundToggle.checked }
  );

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

promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
});

groundToggle.addEventListener("change", () => void refreshGroundingStatus());

// On launch, resume the most recent chat (or start a fresh one if none exist).
async function initChats(): Promise<void> {
  const chats = await window.secondBrain.chatList();
  if (chats[0]) await selectChat(chats[0].id);
  else await newChat();
}

void refreshAiStatus();
void refreshGroundingStatus();
void initChats();
