// ==UserScript==
// @name         Ghost Browser (full)
// @namespace    ghost.mahi
// @version      2.0.0
// @description  Fullscreen CORS-free browser as a userscript. Tabs, omnibox, instant search, proxy-rendered pages, HAR export.
// @author       Mahi
// @match        *://*/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════════════════
  // 0. SAFETY + TOP-WINDOW BRIDGE
  // ══════════════════════════════════════════════════════════════════════════
  const TOP = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  // Only one instance per page
  if (TOP.__ghostBrowserInstalled) return;
  TOP.__ghostBrowserInstalled = true;

  // ══════════════════════════════════════════════════════════════════════════
  // 1. GM BRIDGE (with localStorage fallback)
  // ══════════════════════════════════════════════════════════════════════════
  const hasGM = typeof GM_setValue === 'function';

  const store = {
    get(k, d) {
      if (hasGM) { try { return GM_getValue(k, d); } catch (e) { return d; } }
      try { const v = localStorage.getItem('ghost:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) {
      if (hasGM) { try { GM_setValue(k, v); return; } catch (e) {} }
      try { localStorage.setItem('ghost:' + k, JSON.stringify(v)); } catch (e) {}
    },
    del(k) {
      if (hasGM) { try { GM_deleteValue(k); return; } catch (e) {} }
      try { localStorage.removeItem('ghost:' + k); } catch (e) {}
    },
    keys() {
      if (hasGM) { try { return GM_listValues(); } catch (e) { return []; } }
      return Object.keys(localStorage).filter((k) => k.startsWith('ghost:')).map((k) => k.slice(6));
    }
  };

  const gmFetch = (opts) => new Promise((resolve, reject) => {
    if (typeof GM_xmlhttpRequest !== 'function') return reject(new Error('GM_xmlhttpRequest unavailable'));
    let reqObj;
    try {
      reqObj = GM_xmlhttpRequest({
        method: opts.method || 'GET',
        url: opts.url,
        headers: opts.headers || {},
        data: opts.body,
        responseType: opts.responseType || 'arraybuffer',
        timeout: opts.timeout || 60000,
        withCredentials: opts.withCredentials !== false,
        onload: (r) => resolve({
          status: r.status || 0,
          statusText: r.statusText || '',
          headers: parseGMHeaders(r.responseHeaders),
          response: r.response,
          finalUrl: r.finalUrl || opts.url
        }),
        onerror: (r) => reject(new Error('GM network error: ' + (r && r.error || 'unknown'))),
        ontimeout: () => reject(new Error('GM timeout')),
        onabort: () => reject(new Error('GM aborted'))
      });
    } catch (e) { reject(e); }
    return reqObj;
  });

  function parseGMHeaders(raw) {
    const out = {};
    if (!raw) return out;
    for (const line of String(raw).split(/\r?\n/)) {
      if (!line) continue;
      const i = line.indexOf(':');
      if (i === -1) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (!k) continue;
      out[k] = out[k] ? (out[k] + ', ' + v) : v;
    }
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. SETTINGS
  // ══════════════════════════════════════════════════════════════════════════
  const SETTINGS_KEY = 'settings';
  const SETTINGS_DEFAULTS = {
    engine: 'duckduckgo',
    autoOpenOnBlank: true,
    showLauncher: true,
    stripIntegrity: true,
    blockPopups: true
  };

  let settings = Object.assign({}, SETTINGS_DEFAULTS, store.get(SETTINGS_KEY, {}));
  function saveSettings() { store.set(SETTINGS_KEY, settings); }

  const ENGINES = {
    duckduckgo: (q) => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
    google:     (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q),
    bing:       (q) => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
    brave:      (q) => 'https://search.brave.com/search?q=' + encodeURIComponent(q),
    startpage:  (q) => 'https://www.startpage.com/sp/search?query=' + encodeURIComponent(q)
  };

  // ══════════════════════════════════════════════════════════════════════════
  // 3. HISTORY
  // ══════════════════════════════════════════════════════════════════════════
  const HISTORY_KEY = 'history';
  const HISTORY_MAX = 2000;

  let historyCache = null;

  function historyLoad() {
    if (historyCache) return historyCache;
    const arr = store.get(HISTORY_KEY, []);
    historyCache = Array.isArray(arr) ? arr : [];
    return historyCache;
  }

  function historyFlush() {
    if (!historyCache) return;
    if (historyCache.length > HISTORY_MAX) historyCache.splice(0, historyCache.length - HISTORY_MAX);
    store.set(HISTORY_KEY, historyCache);
  }

  function historyAdd(url, title) {
    if (!url) return;
    if (/^(ghost|about|chrome|devtools|data|blob|javascript):/i.test(url)) return;
    const norm = normalizeUrl(url);
    const list = historyLoad();
    const last = list[list.length - 1];
    if (last && last.url === norm) {
      last.ts = Date.now();
      last.visits = (last.visits || 1) + 1;
      if (title) last.title = String(title).slice(0, 256);
      historyFlush();
      return;
    }
    list.push({ url: norm, title: String(title || '').slice(0, 256), ts: Date.now(), visits: 1 });
    historyFlush();
  }

  function historyAll() { return historyLoad().slice(); }
  function historyRecent(n) { return historyLoad().slice(-n).reverse(); }
  function historyClear() { historyCache = []; historyFlush(); }
  function historyRemove(url) {
    const norm = normalizeUrl(url);
    historyCache = historyLoad().filter((e) => e.url !== norm);
    historyFlush();
  }

  function normalizeUrl(u) {
    if (!u) return '';
    try { const x = new URL(u); x.hash = ''; return x.href; } catch (e) { return String(u); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 4. BOOKMARKS
  // ══════════════════════════════════════════════════════════════════════════
  const BOOKMARK_KEY = 'bookmarks';
  let bookmarkCache = null;

  function bmLoad() {
    if (bookmarkCache) return bookmarkCache;
    const arr = store.get(BOOKMARK_KEY, []);
    bookmarkCache = Array.isArray(arr) ? arr : [];
    return bookmarkCache;
  }
  function bmFlush() { store.set(BOOKMARK_KEY, bmLoad()); }
  function bmAll() { return bmLoad().slice(); }
  function bmHas(url) {
    const n = normalizeUrl(url);
    return bmLoad().some((b) => b.url === n);
  }
  function bmAdd(url, title) {
    const n = normalizeUrl(url);
    if (!n) return null;
    const arr = bmLoad();
    const existing = arr.find((b) => b.url === n);
    if (existing) {
      if (title) existing.title = String(title).slice(0, 256);
      bmFlush();
      return existing;
    }
    const entry = { url: n, title: String(title || n).slice(0, 256), ts: Date.now() };
    arr.unshift(entry);
    bmFlush();
    return entry;
  }
  function bmRemove(url) {
    const n = normalizeUrl(url);
    bookmarkCache = bmLoad().filter((b) => b.url !== n);
    bmFlush();
  }
  function bmToggle(url, title) {
    if (bmHas(url)) { bmRemove(url); return false; }
    bmAdd(url, title); return true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 5. SEARCH INDEX
  // ══════════════════════════════════════════════════════════════════════════
  let searchIndex = null;

  function buildIndex() {
    const h = historyAll();
    const b = bmAll();
    const seen = new Set();
    const out = [];
    for (const e of b) {
      if (!e.url || seen.has(e.url)) continue;
      seen.add(e.url);
      out.push({ url: e.url, title: e.title, ts: e.ts, bookmark: true, visits: 0 });
    }
    for (const e of h) {
      if (!e.url || seen.has(e.url)) continue;
      seen.add(e.url);
      out.push({ url: e.url, title: e.title, ts: e.ts, bookmark: false, visits: e.visits || 1 });
    }
    searchIndex = out;
    return out;
  }

  function invalidateIndex() { searchIndex = null; }

  function looksLikeUrl(q) {
    if (!q || /\s/.test(q)) return false;
    if (/^(https?|ftp|file):\/\//i.test(q)) return true;
    if (/^localhost(:\d+)?(\/.*)?$/i.test(q)) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(q)) return true;
    if (/^[\w-]+(\.[\w-]+){1,}(:\d+)?(\/.*)?$/.test(q)) return true;
    return false;
  }

  function toUrl(q) {
    if (/^(https?|ftp|file):\/\//i.test(q)) return q;
    if (/^localhost/i.test(q)) return 'http://' + q;
    return 'https://' + q;
  }

  function scoreEntry(query, e) {
    const q = query.toLowerCase();
    const url = (e.url || '').toLowerCase();
    const title = (e.title || '').toLowerCase();
    let host = '';
    try { host = new URL(e.url).hostname.replace(/^www\./, '').toLowerCase(); } catch (err) {}
    let s = Infinity;

    if (host === q) s = 0;
    else if (host.startsWith(q)) s = 10 + (host.length - q.length);
    else if (host.includes(q)) s = 40 + host.indexOf(q);
    else if (url.startsWith(q)) s = 70;
    else if (url.includes(q)) s = 100 + Math.min(60, url.indexOf(q));
    else if (title.startsWith(q)) s = 140;
    else if (title.includes(q)) s = 200 + Math.min(80, title.indexOf(q));
    else {
      let i = 0;
      const hay = url + ' ' + title;
      for (const c of hay) { if (c === q[i]) i += 1; if (i === q.length) break; }
      s = (i === q.length) ? 400 : Infinity;
    }

    if (s === Infinity) return Infinity;

    if (e.ts) {
      const ageDays = (Date.now() - e.ts) / 86400000;
      s -= Math.max(0, 60 - ageDays * 1.5);
    }
    if (e.bookmark) s -= 50;
    if (e.visits) s -= Math.min(40, e.visits * 2);
    return s;
  }

  function subset(u) {
    try {
      const x = new URL(u);
      const p = x.pathname.length > 48 ? x.pathname.slice(0, 48) + '…' : x.pathname;
      return x.hostname.replace(/^www\./, '') + (p === '/' ? '' : p);
    } catch (e) { return String(u).slice(0, 80); }
  }

  function search(q, limit) {
    limit = limit || 9;
    q = String(q || '').trim();

    if (!q) {
      const idx = searchIndex || buildIndex();
      idx.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return idx.slice(0, limit).map((e) => ({
        type: e.bookmark ? 'bookmark' : 'history',
        title: e.title || e.url,
        url: e.url,
        subtitle: subset(e.url)
      }));
    }

    const results = [];

    if (looksLikeUrl(q)) {
      results.push({ type: 'url', title: q, url: toUrl(q), subtitle: 'open' });
    }

    const idx = searchIndex || buildIndex();
    const scored = [];
    for (const e of idx) {
      const s = scoreEntry(q, e);
      if (s === Infinity) continue;
      scored.push({ e, s });
    }
    scored.sort((a, b) => a.s - b.s);

    const room = Math.max(1, limit - results.length - 1);
    for (const { e } of scored.slice(0, room)) {
      results.push({
        type: e.bookmark ? 'bookmark' : 'history',
        title: e.title || e.url,
        url: e.url,
        subtitle: subset(e.url)
      });
    }

    const fn = ENGINES[settings.engine] || ENGINES.duckduckgo;
    results.push({
      type: 'search',
      title: q,
      url: fn(q),
      subtitle: 'search · ' + settings.engine
    });

    return results.slice(0, limit);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 6. CHILD RUNTIME — injected into every srcdoc iframe
  //    Patches fetch + XHR + link clicks + window.open. Talks to parent.
  // ══════════════════════════════════════════════════════════════════════════
  function childRuntime(w) {
    if (w.__ghostRuntime) return;
    w.__ghostRuntime = true;
    const B = w.parent && w.parent.ghostBrowser;
    if (!B) return;

    // ── neutralize frame-busters ──
    try { Object.defineProperty(w, 'top', { get: () => w, configurable: true }); } catch (e) {}
    try { Object.defineProperty(w, 'parent', { get: () => w, configurable: true }); } catch (e) {}
    try { Object.defineProperty(w, 'frameElement', { get: () => null, configurable: true }); } catch (e) {}
    try { w.onbeforeunload = null; } catch (e) {}

    // ── patch fetch ──
    const nFetch = w.fetch;
    if (nFetch) {
      w.fetch = async function (input, init) {
        init = init || {};
        let url, method = 'GET', headers = {}, body = null;

        try {
          if (w.Request && input instanceof w.Request) {
            url = input.url;
            method = (init.method || input.method || 'GET').toUpperCase();
            const h = new w.Headers(input.headers || {});
            if (init.headers) new w.Headers(init.headers).forEach((v, k) => h.set(k, v));
            headers = {};
            h.forEach((v, k) => { headers[k] = v; });
            if (init.body !== undefined) body = init.body;
            else if (method !== 'GET' && method !== 'HEAD') {
              try { body = await input.clone().text(); } catch (e) {}
            }
          } else {
            url = String(input);
            method = (init.method || 'GET').toUpperCase();
            if (init.headers) {
              if (w.Headers && init.headers instanceof w.Headers) init.headers.forEach((v, k) => { headers[k] = v; });
              else if (Array.isArray(init.headers)) init.headers.forEach((p) => { headers[p[0]] = p[1]; });
              else Object.assign(headers, init.headers);
            }
            body = init.body;
          }
        } catch (e) {
          if (nFetch) return nFetch.call(w, input, init);
          throw e;
        }

        let absolute;
        try { absolute = new URL(url, w.location.href).href; } catch (e) { absolute = url; }

        // Same-origin to our shell → hand to native
        let sameShell = false;
        try { sameShell = new URL(absolute).origin === w.location.origin; } catch (e) {}
        if (sameShell) return nFetch.call(w, input, init);

        try {
          const r = await B.fetch(absolute, method, headers, body);
          const respHeaders = new w.Headers();
          for (const [k, v] of Object.entries(r.headers || {})) {
            try { respHeaders.set(k, String(v)); } catch (e) {}
          }
          const noBody = r.status === 204 || r.status === 205 || r.status === 304;
          return new w.Response(noBody ? null : r.buffer, {
            status: r.status,
            statusText: r.statusText,
            headers: respHeaders
          });
        } catch (e) {
          if (nFetch) return nFetch.call(w, input, init);
          throw e;
        }
      };
    }

    // ── patch XHR ──
    const NativeXHR = w.XMLHttpRequest;
    if (NativeXHR) {
      const GhostXHR = function () {
        const x = new NativeXHR();
        let _method = 'GET', _url = '';

        const oOpen = x.open;
        x.open = function (m, u) {
          _method = (m || 'GET').toUpperCase();
          try { _url = new URL(u, w.location.href).href; } catch (e) { _url = String(u); }
          return oOpen.apply(x, arguments);
        };

        const oSend = x.send;
        x.send = function (body) {
          let cross = false;
          try { cross = new URL(_url).origin !== w.location.origin; } catch (e) { cross = false; }
          if (!cross) return oSend.call(x, body);

          // GM route
          const normalizedBody = (body == null) ? undefined :
            (typeof body === 'string' ? body :
             (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer ? body :
              (typeof body === 'object' && body.toString ? body.toString() : String(body))));

          B.fetch(_url, _method, {}, normalizedBody).then((r) => {
            const text = safeDecode(r.buffer);
            try {
              Object.defineProperty(x, 'readyState', { value: 4, configurable: true });
              Object.defineProperty(x, 'status', { value: r.status, configurable: true });
              Object.defineProperty(x, 'statusText', { value: r.statusText, configurable: true });
              Object.defineProperty(x, 'responseText', { value: text, configurable: true });
              Object.defineProperty(x, 'response', {
                value: x.responseType === 'json' ? safeJson(text) : text,
                configurable: true
              });
              Object.defineProperty(x, 'responseURL', { value: _url, configurable: true });
              x.getAllResponseHeaders = () => Object.entries(r.headers || {}).map(([k, v]) => k + ': ' + v).join('\r\n');
              x.getResponseHeader = (name) => {
                const t = String(name).toLowerCase();
                for (const [k, v] of Object.entries(r.headers || {})) if (k.toLowerCase() === t) return v;
                return null;
              };
            } catch (e) {}
            fire(x, 'readystatechange');
            fire(x, 'load');
            fire(x, 'loadend');
          }).catch(() => {
            try {
              Object.defineProperty(x, 'readyState', { value: 4, configurable: true });
              Object.defineProperty(x, 'status', { value: 0, configurable: true });
            } catch (e) {}
            fire(x, 'readystatechange');
            fire(x, 'error');
            fire(x, 'loadend');
          });
        };

        return x;
      };
      GhostXHR.UNSENT = 0;
      GhostXHR.OPENED = 1;
      GhostXHR.HEADERS_RECEIVED = 2;
      GhostXHR.LOADING = 3;
      GhostXHR.DONE = 4;
      try { Object.defineProperty(w, 'XMLHttpRequest', { value: GhostXHR, configurable: true, writable: true }); }
      catch (e) { w.XMLHttpRequest = GhostXHR; }
    }

    function fire(target, type) {
      try { const h = target['on' + type]; if (typeof h === 'function') h.call(target, { type, target }); } catch (e) {}
      try { target.dispatchEvent(new w.Event(type)); } catch (e) {}
    }

    function safeDecode(buf) {
      try { return new TextDecoder('utf-8').decode(new Uint8Array(buf)); } catch (e) { return ''; }
    }
    function safeJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }

    // ── intercept link clicks ──
    w.document.addEventListener('click', (e) => {
      if (e.defaultPrevented) return;
      const a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href) return;
      if (href.startsWith('#')) return;
      if (/^(javascript|mailto|tel|blob|data):/i.test(href)) return;

      let abs;
      try { abs = new URL(href, w.location.href).href; } catch (err) { return; }
      if (!/^https?:/i.test(abs)) return;

      e.preventDefault();
      e.stopPropagation();
      B.navigate(abs, e.ctrlKey || e.metaKey || e.shiftKey);
    }, true);

    // ── intercept window.open ──
    const oOpen = w.open;
    w.open = function (url) {
      if (!url) return null;
      let abs;
      try { abs = new URL(url, w.location.href).href; } catch (e) { return null; }
      if (!/^https?:/i.test(abs)) return null;
      B.navigate(abs, true);
      return null;
    };

    // ── history API interception ──
    const oPush = w.history.pushState;
    const oReplace = w.history.replaceState;
    w.history.pushState = function (s, t, u) {
      try {
        if (u) {
          const abs = new URL(u, w.location.href).href;
          B.historyPush(abs);
        }
      } catch (e) {}
      return oPush.apply(w.history, arguments);
    };
    w.history.replaceState = function (s, t, u) {
      try {
        if (u) {
          const abs = new URL(u, w.location.href).href;
          B.historyReplace(abs);
        }
      } catch (e) {}
      return oReplace.apply(w.history, arguments);
    };

    // ── report ready ──
    try { B.ready(w.location.href, w.document.title || ''); } catch (e) {}
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 7. HTML REWRITER
  // ══════════════════════════════════════════════════════════════════════════
  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function rewriteHtml(html, originalUrl) {
    if (!html) return html;

    // strip CSP meta and XFO meta
    html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy[^>]*>/gi, '');
    html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?x-frame-options[^>]*>/gi, '');

    // strip integrity + crossorigin on script/link so hashes don't fail
    if (settings.stripIntegrity) {
      html = html.replace(/\sintegrity\s*=\s*["'][^"']*["']/gi, '');
      html = html.replace(/\scrossorigin(\s*=\s*["'][^"']*["'])?/gi, '');
    }

    // remove any existing base tag (we install our own)
    html = html.replace(/<base\b[^>]*>/gi, '');

    // insert base + runtime right after <head>
    const base = '<base href="' + escapeAttr(originalUrl) + '">';
    const runtime = '<script>(' + childRuntime.toString() + ')(window);</script>';
    const inject = base + runtime;

    if (/<head\b[^>]*>/i.test(html)) {
      html = html.replace(/<head\b[^>]*>/i, (m) => m + inject);
    } else if (/<html\b[^>]*>/i.test(html)) {
      html = html.replace(/<html\b[^>]*>/i, (m) => m + '<head>' + inject + '</head>');
    } else {
      html = '<head>' + inject + '</head>' + html;
    }
    return html;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 8. FETCHER (parent-side, GM routed)
  // ══════════════════════════════════════════════════════════════════════════
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  const DEFAULT_REQ_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache'
  };

  async function ghostFetch(url, method, headers, body) {
    const finalHeaders = Object.assign({}, DEFAULT_REQ_HEADERS, headers || {});
    const r = await gmFetch({
      url,
      method: method || 'GET',
      headers: finalHeaders,
      body,
      responseType: 'arraybuffer'
    });

    let buffer = r.response;
    if (!(buffer instanceof ArrayBuffer)) {
      if (buffer == null) buffer = new ArrayBuffer(0);
      else if (typeof buffer === 'string') buffer = new TextEncoder().encode(buffer).buffer;
      else buffer = new ArrayBuffer(0);
    }

    return {
      status: r.status,
      statusText: r.statusText || '',
      headers: r.headers || {},
      buffer,
      finalUrl: r.finalUrl || url
    };
  }

  async function loadPage(url) {
    const r = await ghostFetch(url, 'GET', {}, undefined);
    const contentType = r.headers['Content-Type'] || r.headers['content-type'] || '';
    const text = new TextDecoder('utf-8').decode(new Uint8Array(r.buffer));
    const isHtml = /text\/html|application\/xhtml/i.test(contentType) || /<html|<head|<body/i.test(text.slice(0, 400));

    if (isHtml) {
      return { kind: 'html', html: rewriteHtml(text, url), url, status: r.status, headers: r.headers };
    }
    return { kind: 'raw', text, url, status: r.status, headers: r.headers };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 9. LOG STORE (for HAR + HUD)
  // ══════════════════════════════════════════════════════════════════════════
  const LOG_MAX = 1000;
  const logRing = [];
  const logSubs = new Set();
  let logSeq = 0;

  function logPush(entry) {
    logSeq += 1;
    const rec = {
      id: logSeq,
      ts: Date.now(),
      method: (entry.method || 'GET').toUpperCase(),
      url: entry.url || '',
      status: entry.status || 0,
      statusText: entry.statusText || '',
      duration: entry.duration || 0,
      bytes: entry.bytes || 0,
      contentType: entry.contentType || '',
      crossOrigin: !!entry.crossOrigin,
      blocked: !!entry.blocked,
      reqHeaders: entry.reqHeaders || null,
      resHeaders: entry.resHeaders || null
    };
    logRing.push(rec);
    if (logRing.length > LOG_MAX) logRing.shift();
    for (const fn of logSubs) { try { fn(rec); } catch (e) {} }
    return rec;
  }

  function logAll() { return logRing.slice(); }
  function logClear() {
    logRing.length = 0;
    for (const fn of logSubs) { try { fn({ id: 0, __clear: true, ts: Date.now() }); } catch (e) {} }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 10. HAR EXPORT
  // ══════════════════════════════════════════════════════════════════════════
  function buildHAR() {
    const entries = logAll().filter((e) => e && !e.__clear && e.url);
    return {
      log: {
        version: '1.2',
        creator: { name: 'Ghost Browser', version: '2.0.0' },
        browser: { name: 'Ghost Browser', version: '2.0.0' },
        pages: [{
          startedDateTime: entries.length ? new Date(entries[0].ts).toISOString() : new Date().toISOString(),
          id: 'page_1',
          title: document.title || 'Ghost session',
          pageTimings: { onContentLoad: -1, onLoad: -1 }
        }],
        entries: entries.map((rec) => {
          const h2a = (h) => Object.entries(h || {}).map(([name, value]) => ({ name, value: String(value) }));
          return {
            pageref: 'page_1',
            startedDateTime: new Date(rec.ts).toISOString(),
            time: rec.duration || 0,
            request: {
              method: rec.method || 'GET',
              url: rec.url,
              httpVersion: 'HTTP/1.1',
              cookies: [],
              headers: h2a(rec.reqHeaders),
              queryString: (() => {
                try { const u = new URL(rec.url); return [...u.searchParams.entries()].map(([name, value]) => ({ name, value })); }
                catch (e) { return []; }
              })(),
              headersSize: -1,
              bodySize: 0
            },
            response: {
              status: rec.status || 0,
              statusText: rec.statusText || '',
              httpVersion: 'HTTP/1.1',
              cookies: [],
              headers: h2a(rec.resHeaders),
              content: { size: rec.bytes || 0, mimeType: rec.contentType || 'application/octet-stream', text: '' },
              redirectURL: '',
              headersSize: -1,
              bodySize: rec.bytes || 0
            },
            cache: {},
            timings: { send: 0, wait: rec.duration || 0, receive: 0 },
            _ghost: { id: rec.id, crossOrigin: !!rec.crossOrigin, blocked: !!rec.blocked }
          };
        })
      }
    };
  }

  function exportHAR() {
    const har = buildHAR();
    const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ghost-' + stamp + '.har';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { document.body.removeChild(a); } catch (e) {}
      URL.revokeObjectURL(url);
    }, 400);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 11. TAB MODEL
  // ══════════════════════════════════════════════════════════════════════════
  let tabSeq = 0;
  const tabs = [];
  let activeTab = null;

  function createTab(url, opts) {
    opts = opts || {};
    const id = ++tabSeq;
    const iframe = document.createElement('iframe');
    iframe.className = 'gb-frame';
    iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-downloads');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.dataset.tabId = String(id);
    iframe.style.display = 'none';

    const tab = {
      id, iframe,
      title: opts.title || 'New Tab',
      url: '',
      history: [],
      historyIdx: -1,
      favicon: null,
      loaded: false
    };
    tabs.push(tab);

    const vp = ui.viewport;
    if (vp) vp.appendChild(iframe);

    if (url) {
      navigateTab(tab, url, { replaceHistory: true });
    } else {
      showNewTab(tab);
    }

    renderTabStrip();
    if (!opts.background) setActiveTab(tab);
    return tab;
  }

  function closeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const [tab] = tabs.splice(idx, 1);
    try { tab.iframe.remove(); } catch (e) {}
    renderTabStrip();
    if (activeTab === tab) {
      const next = tabs[Math.min(idx, tabs.length - 1)];
      if (next) setActiveTab(next);
      else createTab();
    }
  }

  function setActiveTab(tab) {
    if (activeTab === tab) { syncOmniboxToTab(); return; }
    activeTab = tab;
    for (const t of tabs) {
      t.iframe.style.display = (t === tab) ? 'block' : 'none';
    }
    renderTabStrip();
    syncOmniboxToTab();
    updateNavButtons();
    focusOmnibox(false);
    closeResults();
  }

  function syncOmniboxToTab() {
    if (!activeTab) return;
    const omnibox = ui.omnibox;
    if (document.activeElement === omnibox) return;
    omnibox.value = activeTab.url || '';
  }

  function updateNavButtons() {
    if (!ui.back || !ui.forward) return;
    if (!activeTab) {
      ui.back.disabled = true;
      ui.forward.disabled = true;
      return;
    }
    ui.back.disabled = activeTab.historyIdx <= 0;
    ui.forward.disabled = activeTab.historyIdx >= activeTab.history.length - 1;
  }

  async function navigateTab(tab, url, options) {
    options = options || {};
    url = url || '';
    if (!/^https?:/i.test(url)) url = toUrl(url);
    tab.url = url;
    tab.title = subset(url);
    tab.loaded = false;
    renderTabStrip();

    if (options.replaceHistory) {
      if (tab.historyIdx >= 0 && tab.historyIdx < tab.history.length - 1) {
        tab.history.splice(tab.historyIdx + 1);
      }
      tab.history.push(url);
      tab.historyIdx = tab.history.length - 1;
    } else if (options.noHistory) {
      // skip
    } else {
      if (tab.historyIdx >= 0 && tab.history[tab.historyIdx] === url) {
        // same URL, just reload content
      } else {
        if (tab.historyIdx < tab.history.length - 1) {
          tab.history.splice(tab.historyIdx + 1);
        }
        tab.history.push(url);
        tab.historyIdx = tab.history.length - 1;
      }
    }

    // show loading overlay
    showLoading(tab, url);

    const start = Date.now();
    try {
      const result = await loadPage(url);
      logPush({
        method: 'GET',
        url,
        status: result.status,
        duration: Date.now() - start,
        bytes: result.kind === 'html' ? result.html.length : (result.text || '').length,
        contentType: result.headers['Content-Type'] || result.headers['content-type'] || '',
        crossOrigin: true,
        reqHeaders: Object.assign({}, DEFAULT_REQ_HEADERS),
        resHeaders: result.headers
      });

      if (result.kind === 'html') {
        tab.iframe.srcdoc = result.html;
      } else {
        // raw content — wrap in <pre> for safety
        tab.iframe.srcdoc = '<!doctype html><base href="' + escapeAttr(url) + '"><pre style="white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;padding:1rem;color:#e6e8eb;background:#0b0d10">' +
          escapeAttr(result.text).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<') +
          '</pre>';
      }

      tab.loaded = true;
      historyAdd(url, tab.title);
      invalidateIndex();
      syncOmniboxToTab();
      updateNavButtons();
      renderTabStrip();
    } catch (err) {
      showError(tab, url, err.message || String(err));
      logPush({
        method: 'GET',
        url,
        status: 0,
        blocked: true,
        duration: Date.now() - start,
        crossOrigin: true,
        reqHeaders: Object.assign({}, DEFAULT_REQ_HEADERS)
      });
    }
  }

  function showLoading(tab, url) {
    tab.iframe.srcdoc =
      '<!doctype html><html><head><base href="' + escapeAttr(url) + '"><style>' +
      'html,body{margin:0;height:100%;background:#0b0d10;color:#5a636e;' +
      'font:12px ui-monospace,monospace;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px}' +
      '.d{width:24px;height:24px;border-radius:50%;border:2px solid #1c2027;border-top-color:#3b82f6;animation:spin .8s linear infinite}' +
      '@keyframes spin{to{transform:rotate(360deg)}}' +
      '</style></head><body>' +
      '<div class="d"></div>' +
      '<div>loading ' + escapeAttr(subset(url)) + '</div>' +
      '</body></html>';
  }

  function showError(tab, url, message) {
    tab.iframe.srcdoc =
      '<!doctype html><html><head><base href="' + escapeAttr(url) + '"><style>' +
      'html,body{margin:0;height:100%;background:#0b0d10;color:#9aa3ad;' +
      'font:12px ui-monospace,monospace;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;padding:2rem;text-align:center}' +
      '.t{color:#ef4444;font-size:14px;letter-spacing:.5px}' +
      '.u{color:#5a636e;word-break:break-all;max-width:640px}' +
      'button{background:#14171c;color:#9aa3ad;border:1px solid #1c2027;border-radius:6px;padding:8px 16px;cursor:pointer;font:inherit}' +
      'button:hover{background:#1c2027;color:#e6e8eb}' +
      '</style></head><body>' +
      '<div class="t">failed to load</div>' +
      '<div class="u">' + escapeAttr(url) + '</div>' +
      '<div class="u">' + escapeAttr(message) + '</div>' +
      '<button onclick="location.reload()">retry</button>' +
      '</body></html>';
  }

  function navigateActive(url, background) {
    if (background) { createTab(url, { background: true }); return; }
    if (!activeTab) { createTab(url); return; }
    navigateTab(activeTab, url);
  }

  function back() {
    if (!activeTab || activeTab.historyIdx <= 0) return;
    activeTab.historyIdx -= 1;
    const url = activeTab.history[activeTab.historyIdx];
    navigateTab(activeTab, url, { noHistory: true });
  }

  function forward() {
    if (!activeTab || activeTab.historyIdx >= activeTab.history.length - 1) return;
    activeTab.historyIdx += 1;
    const url = activeTab.history[activeTab.historyIdx];
    navigateTab(activeTab, url, { noHistory: true });
  }

  function reloadActive() {
    if (!activeTab || !activeTab.url) return;
    navigateTab(activeTab, activeTab.url, { noHistory: true });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 12. NEW TAB PAGE (rendered inside the iframe)
  // ══════════════════════════════════════════════════════════════════════════
  function newTabHtml() {
    const top = historyRecent(8);
    const bms = bmAll().slice(0, 8);
    const recentHtml = top.length
      ? top.map((e) =>
          '<a class="card" href="' + escapeAttr(e.url) + '">' +
            '<span class="ct">' + escapeAttr(e.title || e.url) + '</span>' +
            '<span class="cu">' + escapeAttr(subset(e.url)) + '</span>' +
          '</a>'
        ).join('')
      : '<div class="empty">no history yet</div>';
    const bmHtml = bms.length
      ? bms.map((e) =>
          '<a class="card" href="' + escapeAttr(e.url) + '">' +
            '<span class="ct">' + escapeAttr(e.title || e.url) + '</span>' +
            '<span class="cu">' + escapeAttr(subset(e.url)) + '</span>' +
          '</a>'
        ).join('')
      : '<div class="empty">no bookmarks yet</div>';

    return '<!doctype html><html><head><style>' +
      'html,body{margin:0;min-height:100%;background:#0b0d10;color:#e6e8eb;' +
      'font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:64px 48px}' +
      '.wrap{max-width:900px;margin:0 auto}' +
      '.logo{font:300 44px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#e6e8eb;letter-spacing:6px;margin-bottom:8px}' +
      '.sub{color:#5a636e;font:11px ui-monospace,monospace;letter-spacing:1px;margin-bottom:56px;text-transform:uppercase}' +
      '.sec{margin-bottom:40px}' +
      '.sec h3{color:#5a636e;font:11px ui-monospace,monospace;letter-spacing:1px;text-transform:uppercase;margin:0 0 14px;font-weight:500}' +
      '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}' +
      '.card{display:flex;flex-direction:column;gap:4px;padding:12px 14px;' +
      'background:#0f1216;border:1px solid #171a1f;border-radius:10px;' +
      'text-decoration:none;color:inherit;transition:border-color .12s,background .12s;overflow:hidden}' +
      '.card:hover{border-color:#3b82f6;background:#14171c}' +
      '.ct{color:#e6e8eb;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.cu{color:#5a636e;font:10px ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.empty{color:#4b5563;font:11px ui-monospace,monospace;padding:12px 0}' +
      '</style></head><body>' +
      '<div class="wrap">' +
        '<div class="logo">ghost</div>' +
        '<div class="sub">cors-free browser · ' + (hasGM ? 'gm routed' : 'limited mode') + '</div>' +
        (bms.length ? '<div class="sec"><h3>bookmarks</h3><div class="grid">' + bmHtml + '</div></div>' : '') +
        '<div class="sec"><h3>recent</h3><div class="grid">' + recentHtml + '</div></div>' +
      '</div>' +
      '</body></html>';
  }

  function showNewTab(tab) {
    tab.url = '';
    tab.title = 'New Tab';
    tab.iframe.srcdoc = newTabHtml();
    tab.loaded = true;
    renderTabStrip();
    syncOmniboxToTab();
    updateNavButtons();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 13. PARENT-SIDE BRIDGE (exposed to iframes via window.ghostBrowser)
  // ══════════════════════════════════════════════════════════════════════════
  const bridge = {
    async fetch(url, method, headers, body) {
      const start = Date.now();
      const result = await ghostFetch(url, method, headers, body);
      const ct = result.headers['Content-Type'] || result.headers['content-type'] || '';
      logPush({
        method: method || 'GET',
        url,
        status: result.status,
        statusText: result.statusText,
        duration: Date.now() - start,
        bytes: result.buffer.byteLength,
        contentType: ct,
        crossOrigin: true,
        reqHeaders: Object.assign({}, DEFAULT_REQ_HEADERS, headers || {}),
        resHeaders: result.headers
      });
      return result;
    },
    navigate(url, background) {
      if (background) { createTab(url, { background: true }); return; }
      navigateActive(url);
    },
    historyPush(url) {
      if (!activeTab) return;
      if (activeTab.url === url) return;
      activeTab.url = url;
      if (activeTab.historyIdx < activeTab.history.length - 1) {
        activeTab.history.splice(activeTab.historyIdx + 1);
      }
      activeTab.history.push(url);
      activeTab.historyIdx = activeTab.history.length - 1;
      syncOmniboxToTab();
      updateNavButtons();
    },
    historyReplace(url) {
      if (!activeTab) return;
      activeTab.url = url;
      if (activeTab.historyIdx >= 0) activeTab.history[activeTab.historyIdx] = url;
      syncOmniboxToTab();
    },
    ready(url, title) {
      if (!activeTab) return;
      // Only update the tab whose iframe fired ready — find by matching url
      const owner = tabs.find((t) => t.iframe && t.iframe.contentWindow === TOP.__ghostLastCaller);
      if (owner) {
        if (title) owner.title = String(title).slice(0, 200);
      } else {
        if (title && activeTab && activeTab.url === url) activeTab.title = String(title).slice(0, 200);
      }
      renderTabStrip();
    }
  };

  // Expose to iframes
  TOP.ghostBrowser = bridge;

  // ══════════════════════════════════════════════════════════════════════════
  // 14. UI CONSTRUCTION
  // ══════════════════════════════════════════════════════════════════════════
  const ui = {
    root: null,
    tabstrip: null,
    viewport: null,
    omnibox: null,
    back: null,
    forward: null,
    reload: null,
    star: null,
    resultsList: null,
    results: null,
    launcher: null,
    status: null
  };

  function buildUI() {
    // Root overlay
    const root = document.createElement('div');
    root.id = 'ghost-browser-root';
    root.innerHTML = `
      <div class="gb-chrome">
        <div class="gb-tabstrip" id="gb-tabstrip"></div>
        <button class="gb-newtab" id="gb-newtab" title="New tab (Ctrl+T)">+</button>
        <div class="gb-flex"></div>
        <button class="gb-chrome-btn" id="gb-close" title="Exit Ghost (Esc)">×</button>
      </div>
      <div class="gb-navbar">
        <button class="gb-nav" id="gb-back" title="Back (Alt+←)">‹</button>
        <button class="gb-nav" id="gb-forward" title="Forward (Alt+→)">›</button>
        <button class="gb-nav" id="gb-reload" title="Reload (Ctrl+R)">⟳</button>
        <div class="gb-omnibox-wrap">
          <input class="gb-omnibox" id="gb-omnibox" type="text" spellcheck="false" autocomplete="off"
                 placeholder="search or enter address — cors is off" />
          <div class="gb-results" id="gb-results" hidden></div>
        </div>
        <button class="gb-nav" id="gb-star" title="Bookmark (Ctrl+D)">☆</button>
        <button class="gb-nav" id="gb-menu" title="Menu">⋯</button>
      </div>
      <div class="gb-viewport" id="gb-viewport"></div>
      <div class="gb-statusbar" id="gb-status"></div>
      <div class="gb-menu-pop" id="gb-menu-pop" hidden>
        <button data-act="har">export HAR</button>
        <button data-act="clear-history">clear history</button>
        <button data-act="clear-log">clear log</button>
        <button data-act="reset">reset everything</button>
      </div>
    `;
    TOP.document.documentElement.appendChild(root);

    const style = document.createElement('style');
    style.textContent = `
      #ghost-browser-root, #ghost-browser-root * {
        box-sizing: border-box;
        margin: 0; padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      #ghost-browser-root {
        position: fixed; inset: 0;
        background: #0b0d10; color: #e6e8eb;
        z-index: 2147483647;
        display: flex; flex-direction: column;
        overflow: hidden;
      }
      .gb-chrome {
        display: flex; align-items: flex-end;
        height: 38px; padding: 0 8px; gap: 2px;
        background: #0b0d10;
        border-bottom: 1px solid #171a1f;
        flex: 0 0 auto;
      }
      .gb-tabstrip { display: flex; gap: 2px; max-width: 70%; overflow-x: auto; scrollbar-width: none; }
      .gb-tabstrip::-webkit-scrollbar { display: none; }
      .gb-tab {
        display: flex; align-items: center; gap: 8px;
        min-width: 150px; max-width: 220px;
        height: 32px; padding: 0 12px;
        background: #14171c;
        border-radius: 8px 8px 0 0;
        font-size: 12px; color: #9aa3ad;
        cursor: pointer; user-select: none;
        white-space: nowrap; overflow: hidden;
      }
      .gb-tab.active { background: #1c2027; color: #e6e8eb; }
      .gb-tab .gb-title { flex: 1; overflow: hidden; text-overflow: ellipsis; }
      .gb-tab .gb-x {
        opacity: 0.5; padding: 0 4px; border-radius: 4px;
      }
      .gb-tab .gb-x:hover { opacity: 1; background: #2a2f38; }
      .gb-newtab {
        width: 32px; height: 32px;
        background: #14171c; color: #9aa3ad;
        border: none; border-radius: 8px 8px 0 0;
        font-size: 18px; cursor: pointer;
        margin-left: 2px;
      }
      .gb-newtab:hover { background: #1c2027; color: #e6e8eb; }
      .gb-flex { flex: 1; }
      .gb-chrome-btn {
        width: 30px; height: 30px;
        background: transparent; border: none;
        color: #5a636e; font-size: 20px;
        cursor: pointer; border-radius: 6px;
        align-self: center;
      }
      .gb-chrome-btn:hover { background: #1c2027; color: #ef4444; }
      .gb-navbar {
        display: flex; align-items: center; gap: 4px;
        height: 44px; padding: 0 10px;
        background: #0f1216;
        border-bottom: 1px solid #171a1f;
        flex: 0 0 auto;
        position: relative;
      }
      .gb-nav {
        width: 32px; height: 32px;
        background: transparent; border: none;
        color: #9aa3ad; font-size: 16px;
        cursor: pointer; border-radius: 6px;
        flex: 0 0 auto;
        display: flex; align-items: center; justify-content: center;
      }
      .gb-nav:hover:not(:disabled) { background: #1c2027; color: #e6e8eb; }
      .gb-nav:disabled { opacity: 0.3; cursor: default; }
      #gb-star.active { color: #eab308; }
      .gb-omnibox-wrap {
        flex: 1; position: relative;
        display: flex; align-items: center;
      }
      .gb-omnibox {
        width: 100%; height: 32px;
        background: #14171c;
        border: 1px solid #1c2027;
        border-radius: 8px;
        padding: 0 14px;
        color: #e6e8eb;
        font: 13px ui-monospace, SFMono-Regular, Menlo, monospace;
        outline: none;
      }
      .gb-omnibox:focus { border-color: #3b82f6; background: #171a1f; }
      .gb-results {
        position: absolute; top: 36px; left: 0; right: 0;
        background: #0f1216;
        border: 1px solid #1c2027;
        border-radius: 10px;
        box-shadow: 0 16px 40px rgba(0,0,0,0.7);
        z-index: 10;
        overflow: hidden;
        max-height: 420px;
        overflow-y: auto;
      }
      .gb-result {
        display: flex; flex-direction: column;
        padding: 8px 14px;
        cursor: pointer;
        border-bottom: 1px solid #101318;
      }
      .gb-result:last-child { border-bottom: none; }
      .gb-result.active { background: #14171c; }
      .gb-result .rt {
        font-size: 13px; color: #e6e8eb;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .gb-result .rs {
        font: 10px ui-monospace, monospace;
        color: #5a636e;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        margin-top: 2px;
      }
      .gb-result .rb {
        display: inline-block;
        font-size: 9px; text-transform: uppercase;
        letter-spacing: 0.5px;
        padding: 1px 5px; margin-right: 6px;
        border-radius: 3px;
        background: #1c2027; color: #9aa3ad;
        vertical-align: middle;
      }
      .gb-result .rb.bm { background: #1e3a2a; color: #6ee7b7; }
      .gb-result .rb.url { background: #1e293b; color: #60a5fa; }
      .gb-result .rb.search { background: #3b2a1e; color: #fbbf24; }
      .gb-viewport {
        flex: 1; position: relative;
        background: #ffffff;
        min-height: 0;
        overflow: hidden;
      }
      .gb-frame {
        width: 100%; height: 100%;
        border: none;
        background: #ffffff;
        position: absolute; inset: 0;
      }
      .gb-statusbar {
        height: 22px;
        background: #0b0d10;
        border-top: 1px solid #171a1f;
        display: flex; align-items: center;
        padding: 0 12px;
        font: 10px ui-monospace, monospace;
        color: #5a636e;
        flex: 0 0 auto;
        gap: 16px;
        overflow: hidden;
      }
      .gb-menu-pop {
        position: absolute; top: 82px; right: 12px;
        background: #0f1216;
        border: 1px solid #1c2027;
        border-radius: 10px;
        box-shadow: 0 16px 40px rgba(0,0,0,0.7);
        z-index: 20;
        overflow: hidden;
        min-width: 200px;
      }
      .gb-menu-pop button {
        display: block; width: 100%;
        background: transparent; border: none;
        color: #9aa3ad;
        text-align: left;
        padding: 10px 16px;
        font: 12px ui-monospace, monospace;
        cursor: pointer;
      }
      .gb-menu-pop button:hover { background: #14171c; color: #e6e8eb; }
    `;
    TOP.document.documentElement.appendChild(style);

    ui.root = root;
    ui.tabstrip = root.querySelector('#gb-tabstrip');
    ui.viewport = root.querySelector('#gb-viewport');
    ui.omnibox = root.querySelector('#gb-omnibox');
    ui.back = root.querySelector('#gb-back');
    ui.forward = root.querySelector('#gb-forward');
    ui.reload = root.querySelector('#gb-reload');
    ui.star = root.querySelector('#gb-star');
    ui.resultsList = root.querySelector('#gb-results');
    ui.status = root.querySelector('#gb-status');

    // ── wire nav buttons ──
    ui.back.addEventListener('click', back);
    ui.forward.addEventListener('click', forward);
    ui.reload.addEventListener('click', reloadActive);
    root.querySelector('#gb-newtab').addEventListener('click', () => createTab());
    root.querySelector('#gb-close').addEventListener('click', hideBrowser);
    ui.star.addEventListener('click', toggleBookmarkActive);

    const menuBtn = root.querySelector('#gb-menu');
    const menuPop = root.querySelector('#gb-menu-pop');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menuPop.hidden = !menuPop.hidden;
    });
    document.addEventListener('click', (e) => {
      if (!menuPop.hidden && !menuPop.contains(e.target) && e.target !== menuBtn) {
        menuPop.hidden = true;
      }
    });
    menuPop.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      menuPop.hidden = true;
      const act = btn.dataset.act;
      if (act === 'har') exportHAR();
      if (act === 'clear-history') { historyClear(); invalidateIndex(); flashStatus('history cleared'); }
      if (act === 'clear-log') { logClear(); flashStatus('log cleared'); }
      if (act === 'reset') resetEverything();
    });

    // ── omnibox behavior ──
    ui.omnibox.addEventListener('focus', () => {
      ui.omnibox.select();
    });

    ui.omnibox.addEventListener('input', () => {
      const q = ui.omnibox.value;
      const results = search(q, 9);
      renderResults(results);
    });

    ui.omnibox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const active = ui.resultsList.querySelector('.gb-result.active');
        if (active && active.dataset.url) {
          navigateActive(active.dataset.url);
        } else {
          const q = ui.omnibox.value.trim();
          if (!q) return;
          const results = search(q, 9);
          if (results.length) navigateActive(results[0].url);
        }
        closeResults();
        ui.omnibox.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeResults();
        syncOmniboxToTab();
        ui.omnibox.blur();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveResultSelection(e.key === 'ArrowDown' ? 1 : -1);
      }
    });

    document.addEventListener('keydown', (e) => {
      handleGlobalKey(e);
    }, true);
  }

  function renderTabStrip() {
    if (!ui.tabstrip) return;
    ui.tabstrip.innerHTML = '';
    for (const t of tabs) {
      const el = document.createElement('div');
      el.className = 'gb-tab' + (t === activeTab ? ' active' : '');
      el.innerHTML =
        '<span class="gb-title">' + escapeHtml(t.title || 'New Tab') + '</span>' +
        '<span class="gb-x">×</span>';
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('gb-x')) {
          e.stopPropagation();
          closeTab(t.id);
        } else {
          setActiveTab(t);
        }
      });
      el.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(t.id);
        }
      });
      ui.tabstrip.appendChild(el);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderResults(results) {
    if (!results || !results.length) {
      closeResults();
      return;
    }
    ui.resultsList.innerHTML = '';
    ui.resultsList.hidden = false;

    results.forEach((r, i) => {
      const el = document.createElement('div');
      el.className = 'gb-result' + (i === 0 ? ' active' : '');
      el.dataset.url = r.url;
      const badgeClass = r.type === 'bookmark' ? 'bm' : (r.type === 'url' ? 'url' : (r.type === 'search' ? 'search' : ''));
      const badge = r.type === 'bookmark' ? 'bookmark' :
                    r.type === 'url' ? 'url' :
                    r.type === 'search' ? 'search' : '';
      el.innerHTML =
        '<div class="rt">' +
          (badge ? '<span class="rb ' + badgeClass + '">' + badge + '</span>' : '') +
          escapeHtml(r.title || r.url) +
        '</div>' +
        '<div class="rs">' + escapeHtml(r.subtitle || r.url) + '</div>';

      el.addEventListener('mouseenter', () => {
        const all = ui.resultsList.querySelectorAll('.gb-result');
        all.forEach((x) => x.classList.remove('active'));
        el.classList.add('active');
      });
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        navigateActive(r.url);
        closeResults();
        ui.omnibox.blur();
      });
      ui.resultsList.appendChild(el);
    });
  }

  function moveResultSelection(delta) {
    const all = [...ui.resultsList.querySelectorAll('.gb-result')];
    if (!all.length) return;
    const currentIdx = all.findIndex((el) => el.classList.contains('active'));
    let nextIdx = (currentIdx < 0 ? 0 : currentIdx + delta);
    if (nextIdx < 0) nextIdx = all.length - 1;
    if (nextIdx >= all.length) nextIdx = 0;
    all.forEach((x) => x.classList.remove('active'));
    all[nextIdx].classList.add('active');
    all[nextIdx].scrollIntoView({ block: 'nearest' });
  }

  function closeResults() {
    if (ui.resultsList) {
      ui.resultsList.hidden = true;
      ui.resultsList.innerHTML = '';
    }
  }

  function focusOmnibox(selectAll) {
    if (!ui.omnibox) return;
    ui.omnibox.focus();
    if (selectAll) ui.omnibox.select();
  }

  function toggleBookmarkActive() {
    if (!activeTab || !activeTab.url) return;
    const added = bmToggle(activeTab.url, activeTab.title);
    invalidateIndex();
    flashStatus(added ? 'bookmarked' : 'bookmark removed');
    updateStarState();
  }

  function updateStarState() {
    if (!ui.star) return;
    const active = activeTab && activeTab.url && bmHas(activeTab.url);
    ui.star.classList.toggle('active', !!active);
    ui.star.textContent = active ? '★' : '☆';
  }

  function flashStatus(msg) {
    if (!ui.status) return;
    ui.status.innerHTML = '<span>' + escapeHtml(msg) + '</span>';
    setTimeout(() => updateStatusbar(), 1600);
  }

  function updateStatusbar() {
    if (!ui.status) return;
    const idx = searchIndex || buildIndex();
    ui.status.innerHTML =
      '<span>' + tabs.length + ' tab' + (tabs.length === 1 ? '' : 's') + '</span>' +
      '<span>' + logRing.length + ' requests</span>' +
      '<span>' + idx.length + ' indexed</span>' +
      '<span>' + (hasGM ? 'gm routed' : 'local mode') + '</span>' +
      '<span>engine: ' + settings.engine + '</span>';
  }

  function handleGlobalKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;

    // Esc — exit browser overlay
    if (key === 'Escape') {
      // If results open, close them first
      if (ui.resultsList && !ui.resultsList.hidden) return;
      if (document.activeElement === ui.omnibox) return;
      e.preventDefault();
      hideBrowser();
      return;
    }

    if (mod && !e.shiftKey && key === 't') {
      e.preventDefault();
      createTab();
      return;
    }
    if (mod && !e.shiftKey && key === 'w') {
      e.preventDefault();
      if (activeTab) closeTab(activeTab.id);
      return;
    }
    if (mod && !e.shiftKey && key === 'l') {
      e.preventDefault();
      focusOmnibox(true);
      return;
    }
    if (mod && !e.shiftKey && key === 'r') {
      e.preventDefault();
      reloadActive();
      return;
    }
    if (mod && e.shiftKey && (key === 'R' || key === 'r')) {
      e.preventDefault();
      if (activeTab && activeTab.url) navigateTab(activeTab, activeTab.url, { noHistory: true });
      return;
    }
    if (mod && !e.shiftKey && key === 'd') {
      e.preventDefault();
      toggleBookmarkActive();
      return;
    }
    if (mod && !e.shiftKey && (key === 'h' || key === 'H')) {
      e.preventDefault();
      exportHAR();
      return;
    }
    if (mod && key === 'Tab') {
      e.preventDefault();
      if (tabs.length < 2) return;
      const i = tabs.indexOf(activeTab);
      const next = tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
      setActiveTab(next);
      return;
    }
    if (key === 'F5') {
      e.preventDefault();
      reloadActive();
      return;
    }
    if (e.altKey && key === 'ArrowLeft') {
      e.preventDefault();
      back();
      return;
    }
    if (e.altKey && key === 'ArrowRight') {
      e.preventDefault();
      forward();
      return;
    }
    if (mod && !e.shiftKey && key >= '1' && key <= '9') {
      const idx = parseInt(key, 10) - 1;
      if (tabs[idx]) {
        e.preventDefault();
        setActiveTab(tabs[idx]);
      }
      return;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 15. LIFECYCLE
  // ══════════════════════════════════════════════════════════════════════════
  let isOpen = false;

  function showBrowser(opts) {
    opts = opts || {};
    if (!ui.root) buildUI();
    ui.root.style.display = 'flex';
    isOpen = true;
    document.documentElement.style.overflow = 'hidden';

    // Kick off perf counters
    updateStatusbar();
    const statusTimer = setInterval(updateStatusbar, 2000);
    TOP.__ghostStatusTimer = statusTimer;

    if (tabs.length === 0) {
      createTab(opts.url);
    } else if (opts.url) {
      navigateActive(opts.url);
    }

    // Focus omnibox if opening with no URL
    if (!opts.url) {
      setTimeout(() => focusOmnibox(true), 30);
    }
  }

  function hideBrowser() {
    if (!ui.root) return;
    ui.root.style.display = 'none';
    isOpen = false;
    document.documentElement.style.overflow = '';
    if (TOP.__ghostStatusTimer) {
      clearInterval(TOP.__ghostStatusTimer);
      TOP.__ghostStatusTimer = null;
    }
  }

  function toggleBrowser() {
    if (isOpen) hideBrowser();
    else showBrowser();
  }

  // reset everything to defaults
  function resetEverything() {
    const keys = store.keys();
    for (const k of keys) {
      if (String(k).startsWith('ghost:') || k === 'settings' || k === 'history' || k === 'bookmarks' || k === 'body rules' || k === 'header rules') {
        store.del(k);
      }
    }
    historyCache = null;
    bookmarkCache = null;
    invalidateIndex();
    settings = Object.assign({}, SETTINGS_DEFAULTS);
    saveSettings();
    flashStatus('reset — reload the page');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 16. MENU COMMANDS + LAUNCHER
  // ══════════════════════════════════════════════════════════════════════════
  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    try {
      GM_registerMenuCommand('Open Ghost Browser (Ctrl+Shift+B)', () => showBrowser());
      GM_registerMenuCommand('Toggle Ghost Browser', () => toggleBrowser());
      GM_registerMenuCommand('Export HAR', () => exportHAR());
      GM_registerMenuCommand('Clear History', () => { historyClear(); invalidateIndex(); });
      GM_registerMenuCommand('Clear Request Log', () => logClear());
    } catch (e) {}
  }

  function buildLauncher() {
    if (!settings.showLauncher) return;
    if (document.getElementById('ghost-launcher')) return;

    const btn = document.createElement('button');
    btn.id = 'ghost-launcher';
    btn.title = 'Open Ghost Browser (Ctrl+Shift+B)';
    btn.textContent = 'G';
    btn.addEventListener('click', () => showBrowser());

    const s = document.createElement('style');
    s.textContent = `
      #ghost-launcher {
        position: fixed; right: 14px; bottom: 14px;
        width: 38px; height: 38px;
        border-radius: 12px;
        background: rgba(15,18,22,0.96);
        color: #e6e8eb;
        border: 1px solid #1c2027;
        font: 600 15px -apple-system, BlinkMacSystemFont, sans-serif;
        cursor: pointer;
        z-index: 2147483646;
        box-shadow: 0 8px 24px rgba(0,0,0,0.55);
        transition: transform 0.1s, background 0.1s, color 0.1s;
        display: flex; align-items: center; justify-content: center;
      }
      #ghost-launcher:hover {
        background: #1c2027; color: #3b82f6;
        transform: scale(1.05);
      }
      #ghost-launcher:active { transform: scale(0.97); }
    `;
    TOP.document.documentElement.appendChild(s);
    TOP.document.documentElement.appendChild(btn);

    // keyboard: ctrl+shift+b
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'B' || e.key === 'b')) {
        e.preventDefault();
        toggleBrowser();
      }
    }, true);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 17. AUTO-OPENER
  // ══════════════════════════════════════════════════════════════════════════
  function isBlankPage() {
    try {
      const u = location.href;
      if (/^(about:blank|about:newtab|about:home|chrome:\/\/newtab)/i.test(u)) return true;
      if (/^https?:\/\/(www\.)?(google\.com\/(_\/chrome\/newtab|webhp)|newtab|duckduckgo\.com\/\?)/i.test(u) && document.body && document.body.children.length < 3) return true;
      if (document.body && document.body.children.length === 0 && !document.body.innerText.trim()) return true;
    } catch (e) {}
    return false;
  }

  function maybeAutoOpen() {
    if (!settings.autoOpenOnBlank) return;
    if (!isBlankPage()) return;

    // Wait a beat so document settles, then open
    setTimeout(() => {
      if (isBlankPage()) showBrowser();
    }, 150);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 18. BOOT
  // ══════════════════════════════════════════════════════════════════════════
  function boot() {
    registerMenuCommands();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        buildLauncher();
        maybeAutoOpen();
      }, { once: true });
    } else {
      buildLauncher();
      maybeAutoOpen();
    }
  }

  // ── expose debug surface ──
  try {
    TOP.ghost = {
      open: showBrowser,
      close: hideBrowser,
      toggle: toggleBrowser,
      search: (q) => search(q, 9),
      history: historyAll,
      bookmarks: bmAll,
      log: logAll,
      exportHAR,
      reset: resetEverything,
      settings: () => Object.assign({}, settings),
      setSetting: (k, v) => { settings[k] = v; saveSettings(); }
    };
  } catch (e) {}

  boot();
})();