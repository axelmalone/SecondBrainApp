import { app, BrowserWindow, ipcMain, dialog } from "electron";
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
} from "./aiSession.js";
import { VaultWatcher } from "./vaultWatcher.js";
import {
  chatAppend,
  chatCreate,
  chatDelete,
  chatList,
  chatLoad,
  initChats,
} from "./chatSession.js";
import type { ConflictResolution } from "../shared/ipc.js";
import type { AiSendOptions, ChatRequest, ProviderId } from "../shared/ai.js";
import type { StoredMessage } from "../shared/chat.js";

// The user's existing Obsidian vault. The open dialog defaults here; the app
// never writes anywhere the user did not explicitly pick.
const VAULT_ROOT = path.join(os.homedir(), "Claude");

let watcher: VaultWatcher | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
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
  ipcMain.handle("vault:open", async () => {
    const res = await dialog.showOpenDialog({
      defaultPath: VAULT_ROOT,
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    const picked = res.filePaths[0];
    if (res.canceled || !picked) return null;
    return openNote(picked);
  });

  ipcMain.handle("vault:save", (_e, p: string, text: string) =>
    saveText(p, text)
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
  ipcMain.handle("ai:indexVault", () => aiIndexVault(VAULT_ROOT));

  ipcMain.handle("chat:list", () => chatList());
  ipcMain.handle("chat:create", () => chatCreate());
  ipcMain.handle("chat:load", (_e, id: string) => chatLoad(id));
  ipcMain.handle("chat:append", (_e, id: string, msg: StoredMessage) =>
    chatAppend(id, msg)
  );
  ipcMain.handle("chat:delete", (_e, id: string) => chatDelete(id));
}

app.whenReady().then(async () => {
  // initAi never throws; a locked/tampered store still lets the editor open.
  await initAi({
    keysPath: path.join(app.getPath("userData"), "keys.enc"),
    keychainBlobPath: path.join(app.getPath("userData"), "master.key.enc"),
  });

  // Durable multi-chat store (D14): app-private, OUTSIDE the vault.
  initChats(path.join(app.getPath("userData"), "chats"));

  // Incremental re-index (D2 + D6): external edits flow through the watcher;
  // the app's own saves re-index directly and suppress the duplicate event.
  watcher = new VaultWatcher({
    root: VAULT_ROOT,
    onChanged: (p) => void reindexNote(p),
    onRemoved: (p) => removeNoteFromIndex(p),
  });
  watcher.start();
  setOnSaved((paths) => {
    for (const p of paths) {
      watcher?.markSelfWrite(p);
      void reindexNote(p);
    }
  });

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
