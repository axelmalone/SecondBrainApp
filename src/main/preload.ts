import { contextBridge, ipcRenderer } from "electron";
import type { SecondBrainAPI } from "../shared/ipc.js";

// The only surface the renderer can see. Every call is a typed round-trip to a
// main-process handler; the renderer gets plain data back, never a file handle
// or a CRDT doc.
const api: SecondBrainAPI = {
  vaultInfo: () => ipcRenderer.invoke("vault:info"),
  vaultChoose: () => ipcRenderer.invoke("vault:choose"),
  vaultCreate: () => ipcRenderer.invoke("vault:create"),
  vaultFiles: () => ipcRenderer.invoke("vault:files"),
  openPath: (path) => ipcRenderer.invoke("vault:openPath", path),
  save: (path, text) => ipcRenderer.invoke("vault:save", path, text),
  resolve: (path, resolution) =>
    ipcRenderer.invoke("vault:resolve", path, resolution),
  renderMarkdown: (source) => ipcRenderer.invoke("editor:render", source),
  openWikilink: (target) => ipcRenderer.invoke("wikilink:open", target),
  openExternal: (url) => ipcRenderer.invoke("link:openExternal", url),
  search: (query) => ipcRenderer.invoke("vault:search", query),
  backlinks: (path) => ipcRenderer.invoke("vault:backlinks", path),
  aiStatus: () => ipcRenderer.invoke("ai:status"),
  aiSetKey: (provider, key) => ipcRenderer.invoke("ai:setKey", provider, key),
  aiSend: (req, opts) => ipcRenderer.invoke("ai:send", req, opts),
  aiGroundingStatus: () => ipcRenderer.invoke("ai:groundingStatus"),
  aiIndexVault: () => ipcRenderer.invoke("ai:indexVault"),
  proposalList: () => ipcRenderer.invoke("proposal:list"),
  proposalDiff: (id) => ipcRenderer.invoke("proposal:diff", id),
  proposalApprove: (id, selectedHunkIds) =>
    ipcRenderer.invoke("proposal:approve", id, selectedHunkIds),
  proposalReject: (id) => ipcRenderer.invoke("proposal:reject", id),
  proposalEdit: (id, content) => ipcRenderer.invoke("proposal:edit", id, content),
  proposalKeepBoth: (id) => ipcRenderer.invoke("proposal:keepBoth", id),
  proposalStats: () => ipcRenderer.invoke("proposal:stats"),
  chatList: () => ipcRenderer.invoke("chat:list"),
  chatCreate: () => ipcRenderer.invoke("chat:create"),
  chatLoad: (id) => ipcRenderer.invoke("chat:load", id),
  chatAppend: (id, msg) => ipcRenderer.invoke("chat:append", id, msg),
  chatRename: (id, title) => ipcRenderer.invoke("chat:rename", id, title),
  chatDelete: (id) => ipcRenderer.invoke("chat:delete", id),
};

contextBridge.exposeInMainWorld("secondBrain", api);
