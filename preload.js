// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ghost', {
  getProxyUrl: () => ipcRenderer.invoke('get-proxy-url'),
  getProxyPort: () => ipcRenderer.invoke('get-proxy-port'),
  clearSession: () => ipcRenderer.invoke('clear-session'),
  onNewTab: (cb) => ipcRenderer.on('open-new-tab', (_e, url) => cb(url))
});