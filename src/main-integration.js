// src/main-integration.js
// Drop-in module: require from main.js and call wireBrowserSidebar({ ipcMain, session, BrowserWindow }).
'use strict';

const logStore = require('./log-store');
const rules = require('./rules-engine');

function wireBrowserSidebar({ ipcMain, session, BrowserWindow }) {
  // ── log IPC ──
  ipcMain.handle('log:all', () => logStore.all());
  ipcMain.handle('log:clear', () => { logStore.clear(); return true; });
  ipcMain.handle('log:stats', () => logStore.stats());

  // ── rules IPC ──
  ipcMain.handle('rules:list', () => rules.list());
  ipcMain.handle('rules:add', (_e, rule) => rules.add(rule));
  ipcMain.handle('rules:update', (_e, id, patch) => rules.update(id, patch));
  ipcMain.handle('rules:remove', (_e, id) => rules.remove(id));
  ipcMain.handle('rules:setEnabled', (_e, id, enabled) => rules.setEnabled(id, enabled));
  ipcMain.handle('rules:reset', () => rules.reset());

  // ── stream new entries to every window ──
  logStore.subscribe((record) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('log:entry', record);
      }
    }
  });

  // ── enhanced response rewriter that also logs and applies rules ──
  const ses = session.defaultSession;

  ses.webRequest.onBeforeRequest((details, callback) => {
    logStore.push({
      method: details.method,
      url: details.url,
      origin: '',
      status: 0,
      bytes: 0,
      tabId: details.webContentsId || null,
      viaProxy: false
    });
    callback({ cancel: false });
  });

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const { headers, applied } = rules.applyRequest(details.url, details.requestHeaders);
    if (applied.length) {
      headers['x-ghost-rules-applied'] = applied.join(',');
    }
    callback({ requestHeaders: headers });
  });

  ses.webRequest.onHeadersReceived((details, callback) => {
    const { headers } = rules.applyResponse(details.url, details.responseHeaders || {});
    callback({ responseHeaders: headers });
  });

  ses.webRequest.onCompleted((details) => {
    const info = logStore.push({
      method: details.method,
      url: details.url,
      status: details.statusCode,
      bytes: details.responseHeaders
        ? parseInt(details.responseHeaders['Content-Length'] || 0, 10) || 0
        : 0,
      tabId: details.webContentsId || null,
      viaProxy: false
    });
    return info;
  });

  ses.webRequest.onErrorOccurred((details) => {
    logStore.push({
      method: details.method,
      url: details.url,
      status: 0,
      blocked: true,
      tabId: details.webContentsId || null,
      viaProxy: false
    });
  });
}

module.exports = { wireBrowserSidebar, logStore, rules };