import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openNote, saveText, resolve, setOnSaved } from "./vaultSession.js";
import {
  aiGroundingStatus,
  aiIndexVault,
  aiSend,
  aiSetKey,
  aiStatus,
  initAi,
  reindexNote,
  removeNoteFromIndex,
  resetGrounding,
  setProposalSink,
} from "./aiSession.js";
import { VaultWatcher } from "./vaultWatcher.js";
import { listTree, isInside } from "./vaultFiles.js";
import { ProposalStore } from "./proposalStore.js";
import { ProposalSession } from "./proposalSession.js";
import { renderMarkdown } from "./markdownRender.js";
import { listMarkdownFiles, noteName } from "./vaultScan.js";
import { LinkIndex } from "./linkIndex.js";
import { SearchIndex } from "./searchIndex.js";
import {
  chatAppend,
  chatCreate,
  chatDelete,
  chatList,
  chatLoad,
  chatRename,
  initChats,
} from "./chatSession.js";
import type { ConflictResolution, VaultInfo } from "../shared/ipc.js";
import type { AiSendOptions, ChatRequest, ProviderId } from "../shared/ai.js";
import type { StoredMessage } from "../shared/chat.js";

// The user's existing Obsidian vault is the default; the chosen root is
// persisted so the app reopens the same vault. The app never writes anywhere
// the user did not explicitly pick.
const DEFAULT_VAULT = path.join(os.homedir(), "Claude");

let vaultConfigPath = "";
let vaultRoot: string | null = null;
let watcher: VaultWatcher | null = null;
let proposals: ProposalSession | null = null;
const linkIndex = new LinkIndex();
const searchIndex = new SearchIndex();

/** Shared post-write side effects: suppress the watcher's own-write event and
 *  re-index the note across grounding + the lightweight link/search indexes.
 *  Used by both the editor save path and proposal apply (the watcher event for
 *  our own write is suppressed, so we must update the indexes directly). */
function afterWrite(paths: string[]): void {
  for (const p of paths) {
    watcher?.markSelfWrite(p);
    void reindexNote(p);
    void linkIndex.reindexNote(p);
    void searchIndex.reindexNote(p);
  }
}

function vaultInfo(): VaultInfo {
  return { root: vaultRoot, name: vaultRoot ? path.basename(vaultRoot) : null };
}

async function persistVaultRoot(): Promise<void> {
  try {
    await fs.writeFile(
      vaultConfigPath,
      JSON.stringify({ root: vaultRoot }),
      "utf8"
    );
  } catch {
    // Non-fatal: the vault still works this session, just won't be remembered.
  }
}

async function loadPersistedRoot(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(vaultConfigPath, "utf8")) as {
      root?: unknown;
    };
    return typeof parsed.root === "string" ? parsed.root : null;
  } catch {
    return null;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a wikilink target (note name, or relative path, with an optional
 * #heading) to an absolute vault path, or null. Matches Obsidian-style: by
 * basename first (case-insensitive), then by relative path.
 */
async function resolveWikilink(target: string): Promise<string | null> {
  if (!vaultRoot) return null;
  const name = (target.split("#")[0] ?? "").trim();
  if (!name) return null;
  const files = await listMarkdownFiles(vaultRoot);
  const lname = name.toLowerCase();
  for (const f of files) {
    if (noteName(f).toLowerCase() === lname) return f;
  }
  for (const f of files) {
    const rel = path.relative(vaultRoot, f).replace(/\\/g, "/").toLowerCase();
    if (rel === lname || rel === `${lname}.md`) return f;
  }
  return null;
}

function startWatcher(root: string): void {
  watcher?.stop();
  watcher = new VaultWatcher({
    root,
    onChanged: (p) => {
      void reindexNote(p);
      void linkIndex.reindexNote(p);
      void searchIndex.reindexNote(p);
      // Proactive staleness (4C): a note changing on disk may stale a pending
      // proposal that targets it. Self-writes are already suppressed above.
      void proposals?.onVaultDirty(p);
    },
    onRemoved: (p) => {
      removeNoteFromIndex(p);
      linkIndex.removeNote(p);
      searchIndex.removeNote(p);
    },
  });
  watcher.start();
}

/** Rebuild the lightweight link + search indexes for the active vault. Cheap
 *  (text only); runs on launch and on every vault switch. Never throws. */
function rebuildIndexes(root: string): void {
  void linkIndex.build(root).catch(() => {});
  void searchIndex.build(root).catch(() => {});
}

/**
 * Switch the active vault: persist the choice, point the watcher at it, and
 * reset the (vault-specific) grounding index so vectors never bleed across
 * vaults. The user re-indexes the new vault on demand.
 */
async function setVaultRoot(root: string): Promise<void> {
  vaultRoot = root;
  await persistVaultRoot();
  startWatcher(root);
  rebuildIndexes(root);
  resetGrounding();
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  void win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

function registerIpc(): void {
  ipcMain.handle("vault:info", () => vaultInfo());

  ipcMain.handle("vault:choose", async () => {
    const res = await dialog.showOpenDialog({
      defaultPath: vaultRoot ?? DEFAULT_VAULT,
      properties: ["openDirectory", "createDirectory"],
    });
    const picked = res.filePaths[0];
    if (res.canceled || !picked) return null;
    await setVaultRoot(picked);
    return vaultInfo();
  });

  ipcMain.handle("vault:create", async () => {
    const res = await dialog.showSaveDialog({
      defaultPath: path.join(
        vaultRoot ? path.dirname(vaultRoot) : os.homedir(),
        "New Vault"
      ),
      buttonLabel: "Create Vault",
    });
    if (res.canceled || !res.filePath) return null;
    await fs.mkdir(res.filePath, { recursive: true });
    await setVaultRoot(res.filePath);
    return vaultInfo();
  });

  ipcMain.handle("vault:files", () => (vaultRoot ? listTree(vaultRoot) : []));

  ipcMain.handle("vault:openPath", (_e, p: string) => {
    if (!vaultRoot || !isInside(vaultRoot, p)) return null;
    const ext = path.extname(p).toLowerCase();
    if (ext !== ".md" && ext !== ".markdown") return null;
    return openNote(p);
  });

  ipcMain.handle("vault:save", (_e, p: string, text: string) =>
    saveText(p, text)
  );

  // Glass-box render (5A): tokenize in main, return the safe RenderNode AST.
  ipcMain.handle("editor:render", async (_e, source: string) => {
    const names = vaultRoot
      ? new Set(
          (await listMarkdownFiles(vaultRoot)).map((f) => noteName(f).toLowerCase())
        )
      : new Set<string>();
    return renderMarkdown(source, (t) =>
      names.has(t.split("#")[0]!.trim().toLowerCase())
    );
  });

  // Click a wikilink → resolve its target note by name/path and open it.
  ipcMain.handle("wikilink:open", async (_e, target: string) => {
    const p = await resolveWikilink(target);
    return p ? openNote(p) : null;
  });

  // External links open in the system browser, never in-app (only safe schemes).
  ipcMain.handle("link:openExternal", (_e, url: string) => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
  });

  // Glass-box search + backlinks (6A) — decoupled from grounding.
  ipcMain.handle("vault:search", (_e, query: string) => searchIndex.search(query));
  ipcMain.handle("vault:backlinks", (_e, p: string) =>
    vaultRoot && isInside(vaultRoot, p) ? linkIndex.backlinksFor(p) : []
  );

  ipcMain.handle(
    "vault:resolve",
    (_e, p: string, resolution: ConflictResolution) => resolve(p, resolution)
  );

  ipcMain.handle("ai:status", () => aiStatus());
  ipcMain.handle("ai:setKey", (_e, provider: ProviderId, key: string) =>
    aiSetKey(provider, key)
  );
  ipcMain.handle("ai:send", (_e, req: ChatRequest, opts?: AiSendOptions) =>
    aiSend(req, opts)
  );
  ipcMain.handle("ai:groundingStatus", () => aiGroundingStatus());
  ipcMain.handle("ai:indexVault", () =>
    vaultRoot
      ? aiIndexVault(vaultRoot)
      : { ok: false as const, message: "no vault selected" }
  );

  ipcMain.handle("proposal:list", () => proposals?.list() ?? []);
  ipcMain.handle("proposal:approve", (_e, id: string) =>
    proposals
      ? proposals.approve(id)
      : { status: "error" as const, message: "proposals unavailable" }
  );
  ipcMain.handle("proposal:reject", (_e, id: string) => proposals?.reject(id));
  ipcMain.handle("proposal:edit", (_e, id: string, content: string) =>
    proposals ? proposals.edit(id, content) : null
  );
  ipcMain.handle("proposal:keepBoth", (_e, id: string) =>
    proposals
      ? proposals.keepBoth(id)
      : { status: "error" as const, message: "proposals unavailable" }
  );
  ipcMain.handle("proposal:stats", () =>
    proposals?.stats() ?? {
      proposed: 0,
      approved: 0,
      edited: 0,
      rejected: 0,
      pending: 0,
      acceptanceRate: 0,
    }
  );

  ipcMain.handle("chat:list", () => chatList());
  ipcMain.handle("chat:create", () => chatCreate());
  ipcMain.handle("chat:load", (_e, id: string) => chatLoad(id));
  ipcMain.handle("chat:append", (_e, id: string, msg: StoredMessage) =>
    chatAppend(id, msg)
  );
  ipcMain.handle("chat:rename", (_e, id: string, title: string) =>
    chatRename(id, title)
  );
  ipcMain.handle("chat:delete", (_e, id: string) => chatDelete(id));
}

app.whenReady().then(async () => {
  vaultConfigPath = path.join(app.getPath("userData"), "vault.json");

  // initAi never throws; a locked/tampered store still lets the editor open.
  await initAi({
    keysPath: path.join(app.getPath("userData"), "keys.enc"),
    keychainBlobPath: path.join(app.getPath("userData"), "master.key.enc"),
  });

  // Durable multi-chat store (D14): app-private, OUTSIDE the vault.
  initChats(path.join(app.getPath("userData"), "chats"));

  // Write-back review queue: app-private proposals.jsonl, OUTSIDE the vault.
  const proposalStore = new ProposalStore(
    path.join(app.getPath("userData"), "proposals")
  );
  proposals = new ProposalSession({
    store: proposalStore,
    getRoot: () => vaultRoot,
    onApplied: afterWrite,
  });
  // A parsed proposal from a chat turn is persisted here (and security-checked).
  setProposalSink((draft, backref) => proposals!.create(draft, backref));
  // 7A crash recovery + 1A compaction: verify-then-reconcile any interrupted
  // apply, then archive resolved proposals. Never throws → never blocks launch.
  await proposals.recoverOnLaunch().catch(() => {});

  // Resolve the active vault: only an EXPLICIT prior choice is restored. We no
  // longer silently adopt ~/Claude — a user with no chosen vault is shown the
  // first-launch popup and picks one explicitly (the picker still defaults to
  // ~/Claude for convenience). This keeps "which vault?" an intentional act.
  const persisted = await loadPersistedRoot();
  if (persisted && (await dirExists(persisted))) {
    vaultRoot = persisted;
  }

  // Incremental re-index (D2 + D6): external edits flow through the watcher;
  // the app's own saves re-index directly and suppress the duplicate event.
  if (vaultRoot) {
    startWatcher(vaultRoot);
    rebuildIndexes(vaultRoot);
  }
  setOnSaved(afterWrite);

  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  watcher?.stop();
  watcher = null;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
