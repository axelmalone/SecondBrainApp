import { contextBridge, ipcRenderer } from "electron";
import type { SecondBrainAPI } from "../shared/ipc.js";

// The only surface the renderer can see. Every call is a typed round-trip to a
// main-process handler; the renderer gets plain data back, never a file handle
// or a CRDT doc.
const api: SecondBrainAPI = {
  open: () => ipcRenderer.invoke("vault:open"),
  save: (path, text) => ipcRenderer.invoke("vault:save", path, text),
  resolve: (path, resolution) =>
    ipcRenderer.invoke("vault:resolve", path, resolution),
  aiStatus: () => ipcRenderer.invoke("ai:status"),
  aiSetKey: (provider, key) => ipcRenderer.invoke("ai:setKey", provider, key),
  aiSend: (req, opts) => ipcRenderer.invoke("ai:send", req, opts),
  aiGroundingStatus: () => ipcRenderer.invoke("ai:groundingStatus"),
  aiIndexVault: () => ipcRenderer.invoke("ai:indexVault"),
  chatList: () => ipcRenderer.invoke("chat:list"),
  chatCreate: () => ipcRenderer.invoke("chat:create"),
  chatLoad: (id) => ipcRenderer.invoke("chat:load", id),
  chatAppend: (id, msg) => ipcRenderer.invoke("chat:append", id, msg),
  chatDelete: (id) => ipcRenderer.invoke("chat:delete", id),
};

contextBridge.exposeInMainWorld("secondBrain", api);
