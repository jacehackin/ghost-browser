// src/main-integration-v2.js
// Upgrade path: replaces main-integration.js with body rewriting, HAR export,
// per-tab proxy switching, and full request/response capture (headers + timing).
'use strict';

const { ipcMain, session, BrowserWindow, app, dialog } = require('electron');
const zlib = require('zlib');

const logStore = require('./log-store');
const rules = require('./rules-engine');
const bodyRewriter = require('./body-rewriter');
const har = require('./har-exporter');
const tabState = require('./tab-state');
const proxyRouter = require('./proxy-router');

const MAX_BODY_CAPTURE = 256 * 1024; // 256 KB per response, HAR-friendly

// ── in-flight request map keyed by Electron's request id ──
const inflight = new Map();

function safeLower(headers) {
  const out = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function headerValue(headers, name) {
  const lower = safeLower(headers);
  return lower[name.toLowerCase()];
}

function plainHeaders(headers) {
  const out = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

async function captureStream(stream, encoding) {
  const chunks = [];
  let total = 0;
  return new Promise((resolve) => {
    stream.on('data', (chunk) => {
      total += chunk.length;
      if (total <= MAX_BODY_CAPTURE) chunks.push(chunk);
    });
    stream.on('end', () => {
      let buf = Buffer.concat(chunks);
      const enc = (encoding || 'identity').toLowerCase();
      try {
        if (enc === 'gzip' || enc === 'x-gzip') buf = zlib.gunzipSync(buf);
        else if (enc === 'deflate') buf = zlib.inflateSync(buf);
        else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
      } catch (e) { /* keep raw */ }
      resolve({ buf, truncated: total > MAX_BODY_CAPTURE, total });
    });
    stream.on('error', () => resolve({ buf: Buffer.alloc(0), truncated: false, total }));
  });
}

function wireBrowserSidebar({ ipcMain, session, BrowserWindow, app, dialog }) {
  // ── log IPC ──
  ipcMain.handle('log:all', () => logStore.all());
  ipcMain.handle('log:clear', () => { logStore.clear(); return true; });
  ipcMain.handle('log:stats', () => logStore.stats());

  // ── rules IPC (header) ──
  ipcMain.handle('rules:list', () => rules.list());
  ipcMain.handle('rules:add', (_e, rule) => rules.add(rule));
  ipcMain.handle('rules:update', (_e, id, patch) => rules.update(id, patch));
  ipcMain.handle('rules:remove', (_e, id) => rules.remove(id));
  ipcMain.handle('rules:setEnabled', (_e, id, enabled) => rules.setEnabled(id, enabled));
  ipcMain.handle('rules:reset', () => rules.reset());

  // ── body rule IPC ──
  ipcMain.handle('body:list', () => bodyRewriter.list());
  ipcMain.handle('body:add', (_e, rule) => bodyRewriter.add(rule));
  ipcMain.handle('body:update', (_e, id, patch) => bodyRewriter.update(id, patch));
  ipcMain.handle('body:remove', (_e, id) => bodyRewriter.remove(id));
  ipcMain.handle('body:setEnabled', (_e, id, enabled) => bodyRewriter.setEnabled(id, enabled));
  ipcMain.handle('body:reset', () => bodyRewriter.reset());

  // ── HAR export ──
  ipcMain.handle('har:export', async (_e, meta) => {
    return await har.exportToFile(logStore.all(), meta || {});
  });

  // ── proxy IPC ──
  ipcMain.handle('proxy:get', () => tabState.all());
  ipcMain.handle('proxy:setGlobal', (_e, value) => {
    const r = tabState.setGlobalProxy(value);
    proxyRouter.invalidate();
    session.defaultSession.setProxy(proxyRouter.toElectronProxy(value)).catch(() => {});
    return r;
  });
  ipcMain.handle('proxy:setTab', (_e, id, value) => {
    return tabState.setTabProxy(id, value);
  });

  // ── register / unregister tabs as they're created ──
  app.on('web-contents-created', (_ev, contents) => {
    const id = contents.id;
    tabState.registerTab(id, { title: contents.getTitle() || 'tab' });

    contents.on('page-title-updated', (_e, title) => {
      tabState.registerTab(id, { title });
    });

    contents.on('destroyed', () => {
      tabState.unregisterTab(id);
    });
  });

  // ── stream log records to every renderer ──
  logStore.subscribe((record) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('log:entry', record);
    }
  });

  // ── request phase ──
  const ses = session.defaultSession;

  ses.webRequest.onBeforeRequest((details, callback) => {
    inflight.set(details.id, {
      start: Date.now(),
      method: details.method,
      url: details.url,
      tabId: details.webContentsId || null,
      reqHeaders: null,
      resHeaders: null,
      status: 0,
      bodyText: '',
      bodyEncoding: undefined,
      truncated: false
    });
    callback({ cancel: false });
  });

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const { headers, applied } = rules.applyRequest(details.url, details.requestHeaders);
    if (applied.length) headers['x-ghost-rules-applied'] = applied.join(',');

    const rec = inflight.get(details.id);
    if (rec) rec.reqHeaders = plainHeaders(headers);

    callback({ requestHeaders: headers });
  });

  ses.webRequest.onHeadersReceived((details, callback) => {
    const { headers } = rules.applyResponse(details.url, details.responseHeaders || {});

    const rec = inflight.get(details.id);
    if (rec) rec.resHeaders = plainHeaders(headers);

    callback({ responseHeaders: headers });
  });

  // ── response capture (text bodies only, capped) ──
  ses.webRequest.onResponseStarted((details) => {
    const rec = inflight.get(details.id);
    if (rec) rec.status = details.statusCode || 0;
  });

  ses.webRequest.onCompleted(async (details) => {
    const rec = inflight.get(details.id) || {
      method: details.method,
      url: details.url,
      tabId: details.webContentsId || null
    };
    const duration = rec.start ? Date.now() - rec.start : 0;

    const resHeaders = details.responseHeaders || rec.resHeaders || {};
    const ct = String(headerValue(resHeaders, 'content-type') || '');
    const cl = parseInt(String(headerValue(resHeaders, 'content-length') || '0'), 10) || 0;

    logStore.push({
      method: details.method,
      url: details.url,
      status: details.statusCode || rec.status || 0,
      origin: String(headerValue(rec.reqHeaders || {}, 'origin') || ''),
      bytes: cl,
      duration,
      viaProxy: false,
      tabId: rec.tabId,
      reqHeaders: rec.reqHeaders,
      resHeaders: plainHeaders(resHeaders),
      contentType: ct
    });

    inflight.delete(details.id);
  });

  ses.webRequest.onErrorOccurred((details) => {
    const rec = inflight.get(details.id);
    logStore.push({
      method: details.method,
      url: details.url,
      status: 0,
      blocked: true,
      duration: rec && rec.start ? Date.now() - rec.start : 0,
      tabId: rec ? rec.tabId : (details.webContentsId || null),
      reqHeaders: rec ? rec.reqHeaders : null,
      error: details.error || 'net::ERR_FAILED'
    });
    inflight.delete(details.id);
  });

  // ── protocol-level body rewriter for GETs the session handles ──
  // Chromium's webRequest can't mutate bodies in-place, so we intercept via a
  // second pass on the proxy: the proxy reads, transforms, and re-emits.
  // Wire the proxy's transform hook here:
  const proxy = require('./proxy');
  if (proxy.setBodyTransform) {
    proxy.setBodyTransform(async (info) => {
      const { url, contentType, encoding, buffer } = info;
      const result = await bodyRewriter.transformResponse({
        url, contentType, encoding, buffer
      });
      if (result.changed) {
        logStore.push({
          method: 'BODY',
          url,
          status: 200,
          bytes: result.buffer.length,
          viaProxy: true,
          bodyRewritten: true,
          appliedRules: result.applied
        });
      }
      return result;
    });
  }
}

module.exports = {
  wireBrowserSidebar,
  logStore,
  rules,
  bodyRewriter,
  har,
  tabState,
  proxyRouter
};