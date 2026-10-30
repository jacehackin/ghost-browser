// src/har-exporter.js
// Turns the in-memory request log into a valid HAR 1.2 document.
'use strict';

const { app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

function contentTypeFromHeaders(headers) {
  if (!headers) return 'application/octet-stream';
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
  if (!key) return 'application/octet-stream';
  const v = headers[key];
  return Array.isArray(v) ? String(v[0]) : String(v);
}

function headersToArray(headers) {
  if (!headers) return [];
  const out = [];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const v of value) out.push({ name, value: String(v) });
    } else {
      out.push({ name, value: String(value) });
    }
  }
  return out;
}

function buildEntry(rec, index) {
  const startedDateTime = new Date(rec.ts).toISOString();
  let parsedUrl = { protocol: 'http:', host: '', pathname: '/', queryString: [] };
  try {
    const u = new URL(rec.url);
    const qs = [];
    for (const [name, value] of u.searchParams.entries()) qs.push({ name, value });
    parsedUrl = {
      protocol: u.protocol,
      host: u.host,
      pathname: u.pathname,
      queryString: qs
    };
  } catch (e) { /* keep defaults */ }

  const reqHeaders = headersToArray(rec.reqHeaders);
  const resHeaders = headersToArray(rec.resHeaders);

  return {
    pageref: 'page_1',
    startedDateTime,
    time: rec.duration || 0,
    request: {
      method: rec.method || 'GET',
      url: rec.url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: reqHeaders,
      queryString: parsedUrl.queryString,
      postData: rec.postData
        ? { mimeType: rec.postData.mimeType || 'application/octet-stream', text: rec.postData.text || '' }
        : undefined,
      headersSize: -1,
      bodySize: rec.requestBytes || 0
    },
    response: {
      status: rec.status || 0,
      statusText: rec.statusText || '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: resHeaders,
      content: {
        size: rec.bytes || 0,
        mimeType: contentTypeFromHeaders(rec.resHeaders),
        text: rec.bodyText || '',
        encoding: rec.bodyEncoding || undefined
      },
      redirectURL: (rec.resHeaders && (rec.resHeaders.Location || rec.resHeaders.location)) || '',
      headersSize: -1,
      bodySize: rec.bytes || 0
    },
    cache: {},
    timings: {
      send: 0,
      wait: rec.duration || 0,
      receive: 0
    },
    serverIPAddress: rec.serverIP || '',
    connection: rec.connection || '',
    _ghost: {
      id: rec.id,
      viaProxy: !!rec.viaProxy,
      blocked: !!rec.blocked,
      tabId: rec.tabId
    }
  };
}

function buildHar(entries, meta) {
  const filtered = entries.filter((e) => e && !e.__clear && e.url);
  return {
    log: {
      version: '1.2',
      creator: {
        name: 'Ghost',
        version: '1.0.0',
        comment: 'CORS-free browser — HAR export'
      },
      browser: {
        name: 'Ghost',
        version: '1.0.0'
      },
      pages: [
        {
          startedDateTime: filtered.length
            ? new Date(filtered[0].ts).toISOString()
            : new Date().toISOString(),
          id: 'page_1',
          title: (meta && meta.title) || 'Ghost session',
          pageTimings: {
            onContentLoad: -1,
            onLoad: -1
          }
        }
      ],
      entries: filtered.map(buildEntry)
    }
  };
}

async function exportToFile(entries, meta) {
  const har = buildHar(entries, meta);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export HAR',
    defaultPath: path.join(app.getPath('downloads'), `ghost-${stamp}.har`),
    filters: [
      { name: 'HAR archive', extensions: ['har'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  });

  if (canceled || !filePath) return { ok: false, canceled: true };

  await fs.promises.writeFile(filePath, JSON.stringify(har, null, 2), 'utf8');
  return { ok: true, filePath, entryCount: har.log.entries.length };
}

async function exportToPath(entries, filePath, meta) {
  const har = buildHar(entries, meta);
  await fs.promises.writeFile(filePath, JSON.stringify(har, null, 2), 'utf8');
  return { ok: true, filePath, entryCount: har.log.entries.length };
}

module.exports = { buildHar, exportToFile, exportToPath };