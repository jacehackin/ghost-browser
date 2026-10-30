// ==UserScript==
// @name         Ghost — CORS-Free Browser-in-a-Userscript
// @namespace    ghost.mahi
// @version      1.0.0
// @description  Full CORS bypass, CSP strip, frame-buster neutralizer, live request log, header+body rewriting, HAR export. All in one userscript.
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

  // ═══════════════════════════════════════════════════════════════════
  // 0. GM BRIDGE
  // ═══════════════════════════════════════════════════════════════════
  const gm = {
    xhr:  (o) => GM_xmlhttpRequest(o),
    get:  (k, d) => GM_getValue(k, d),
    set:  (k, v) => GM_setValue(k, v),
    del:  (k) => GM_deleteValue(k),
    list: () => GM_listValues(),
    menu: (label, fn) => GM_registerMenuCommand(label, fn),
    notify: (text, title) => { try { GM_notification({ text, title: title || 'Ghost' }); } catch (e) {} }
  };

  const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // ═══════════════════════════════════════════════════════════════════
  // 1. CONSTANTS
  // ═══════════════════════════════════════════════════════════════════
  const LS_SETTINGS = 'ghost:settings';
  const LS_RULES    = 'ghost:rules:header';
  const LS_BODY     = 'ghost:rules:body';
  const MAX_LOG     = 1500;
  const MAX_BODY    = 512 * 1024;

  // ═══════════════════════════════════════════════════════════════════
  // 2. SETTINGS
  // ═══════════════════════════════════════════════════════════════════
  const DEFAULT_SETTINGS = {
    cspStrip: true,
    frameBuster: true,
    patchFetch: true,
    patchXHR: true,
    verbose: false,
    hudVisible: false
  };

  const settings = Object.assign({}, DEFAULT_SETTINGS, gm.get(LS_SETTINGS, {}));

  function saveSettings() {
    gm.set(LS_SETTINGS, settings);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 3. RULE ENGINE — HEADER RULES
  // ═══════════════════════════════════════════════════════════════════
  const DEFAULT_HEADER_RULES = [
    {
      id: 'strip-csp',
      enabled: true,
      match: '.*',
      phase: 'response',
      set: {},
      remove: [
        'Content-Security-Policy',
        'Content-Security-Policy-Report-Only',
        'X-WebKit-CSP',
        'X-Content-Security-Policy'
      ]
    },
    {
      id: 'permissive-cors',
      enabled: true,
      match: '.*',
      phase: 'response',
      set: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Expose-Headers': '*',
        'Access-Control-Max-Age': '86400'
      },
      remove: [
        'Cross-Origin-Opener-Policy',
        'Cross-Origin-Embedder-Policy',
        'Cross-Origin-Resource-Policy',
        'X-Frame-Options',
        'Strict-Transport-Security'
      ]
    }
  ];

  let headerRules = gm.get(LS_RULES, null);
  if (!Array.isArray(headerRules) || !headerRules.length) {
    headerRules = DEFAULT_HEADER_RULES.map((r) => Object.assign({}, r));
    gm.set(LS_RULES, headerRules);
  }

  let compiledHeaderRe = new Map();

  function compileHeaderRules() {
    compiledHeaderRe.clear();
    for (const r of headerRules) {
      let re;
      try {
        re = new RegExp(r.match === '*' ? '.*' : (r.match || '.*'));
      } catch (e) {
        re = /$^/;
      }
      compiledHeaderRe.set(r.id, re);
    }
  }
  compileHeaderRules();

  function headerMatch(id, url) {
    const re = compiledHeaderRe.get(id);
    return re ? re.test(url) : false;
  }

  function applyRequestRules(url, headers) {
    const out = Object.assign({}, headers || {});
    const applied = [];
    for (const r of headerRules) {
      if (!r.enabled) continue;
      if (r.phase !== 'request' && r.phase !== 'both') continue;
      if (!headerMatch(r.id, url)) continue;

      if (Array.isArray(r.remove) && r.remove.length) {
        const kill = new Set(r.remove.map((h) => h.toLowerCase()));
        for (const k of Object.keys(out)) {
          if (kill.has(k.toLowerCase())) delete out[k];
        }
      }
      if (r.set && typeof r.set === 'object') {
        for (const [k, v] of Object.entries(r.set)) out[k] = v;
      }
      applied.push(r.id);
    }
    return { headers: out, applied };
  }

  function applyResponseRules(url, headers) {
    const out = Object.assign({}, headers || {});
    const applied = [];
    for (const r of headerRules) {
      if (!r.enabled) continue;
      if (r.phase !== 'response' && r.phase !== 'both') continue;
      if (!headerMatch(r.id, url)) continue;

      if (Array.isArray(r.remove) && r.remove.length) {
        const kill = new Set(r.remove.map((h) => h.toLowerCase()));
        for (const k of Object.keys(out)) {
          if (kill.has(k.toLowerCase())) delete out[k];
        }
      }
      if (r.set && typeof r.set === 'object') {
        for (const [k, v] of Object.entries(r.set)) out[k] = v;
      }
      applied.push(r.id);
    }
    return { headers: out, applied };
  }

  function persistHeaderRules() {
    gm.set(LS_RULES, headerRules);
    compileHeaderRules();
  }

  function addHeaderRule(rule) {
    rule.id = rule.id || ('hr-' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36));
    rule.enabled = rule.enabled !== false;
    rule.phase = rule.phase || 'both';
    rule.match = rule.match || '.*';
    rule.set = rule.set || {};
    rule.remove = rule.remove || [];
    headerRules.push(rule);
    persistHeaderRules();
    return rule;
  }

  function updateHeaderRule(id, patch) {
    const i = headerRules.findIndex((r) => r.id === id);
    if (i === -1) return null;
    headerRules[i] = Object.assign({}, headerRules[i], patch);
    persistHeaderRules();
    return headerRules[i];
  }

  function removeHeaderRule(id) {
    const before = headerRules.length;
    headerRules = headerRules.filter((r) => r.id !== id);
    persistHeaderRules();
    return headerRules.length !== before;
  }

  function resetHeaderRules() {
    headerRules = DEFAULT_HEADER_RULES.map((r) => Object.assign({}, r));
    persistHeaderRules();
    return headerRules;
  }

  // ═══════════════════════════════════════════════════════════════════
  // 4. RULE ENGINE — BODY RULES
  // ═══════════════════════════════════════════════════════════════════
  const DEFAULT_BODY_RULES = [
    {
      id: 'unwrap-envelope',
      enabled: false,
      match: '.*/api/.*',
      contentType: 'application/json',
      mode: 'json',
      order: 100,
      transform: 'if (data && typeof data === "object" && "data" in data && Object.keys(data).length === 1) return data.data; return data;'
    }
  ];

  let bodyRules = gm.get(LS_BODY, null);
  if (!Array.isArray(bodyRules) || !bodyRules.length) {
    bodyRules = DEFAULT_BODY_RULES.map((r) => Object.assign({}, r));
    gm.set(LS_BODY, bodyRules);
  }

  let compiledBodyRules = [];

  function compileBodyRules() {
    compiledBodyRules = [];
    const sorted = bodyRules.slice().filter((r) => r.enabled).sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const r of sorted) {
      let urlRe, ctRe, fn = null;
      try { urlRe = new RegExp(r.match || '.*'); } catch (e) { urlRe = /$^/; }
      try { ctRe = new RegExp(r.contentType || '.*'); } catch (e) { ctRe = /.*/; }
      if (r.transform) {
        try {
          fn = new Function('data', '"use strict";\n' + r.transform + '\n');
        } catch (e) { fn = null; }
      }
      compiledBodyRules.push({ rule: r, urlRe, ctRe, fn });
    }
  }
  compileBodyRules();

  function persistBodyRules() {
    gm.set(LS_BODY, bodyRules);
    compileBodyRules();
  }

  function addBodyRule(rule) {
    rule.id = rule.id || ('br-' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36));
    rule.enabled = rule.enabled !== false;
    rule.mode = rule.mode || 'json';
    rule.match = rule.match || '.*';
    rule.contentType = rule.contentType || 'application/json';
    rule.order = rule.order || 100;
    rule.transform = rule.transform || 'return data;';
    bodyRules.push(rule);
    persistBodyRules();
    return rule;
  }

  function updateBodyRule(id, patch) {
    const i = bodyRules.findIndex((r) => r.id === id);
    if (i === -1) return null;
    bodyRules[i] = Object.assign({}, bodyRules[i], patch);
    persistBodyRules();
    return bodyRules[i];
  }

  function removeBodyRule(id) {
    const before = bodyRules.length;
    bodyRules = bodyRules.filter((r) => r.id !== id);
    persistBodyRules();
    return bodyRules.length !== before;
  }

  function resetBodyRules() {
    bodyRules = DEFAULT_BODY_RULES.map((r) => Object.assign({}, r));
    persistBodyRules();
    return bodyRules;
  }

  async function applyBodyRules(url, contentType, buffer) {
    if (!compiledBodyRules.length) return { buffer, changed: false, applied: [] };

    let text = null;
    try {
      text = new TextDecoder('utf-8').decode(new Uint8Array(buffer));
    } catch (e) {
      return { buffer, changed: false, applied: [] };
    }

    let anyChanged = false;
    const appliedIds = [];

    for (const { rule, urlRe, ctRe, fn } of compiledBodyRules) {
      if (!fn) continue;
      if (!urlRe.test(url)) continue;
      if (!ctRe.test(contentType || '')) continue;

      try {
        if (rule.mode === 'json') {
          const parsed = JSON.parse(text);
          const out = fn(parsed);
          const next = JSON.stringify(out);
          if (next !== text) { text = next; anyChanged = true; }
        } else {
          const out = fn(text);
          if (typeof out === 'string' && out !== text) { text = out; anyChanged = true; }
        }
        appliedIds.push(rule.id);
      } catch (e) {
        // skip malformed rule; others continue
      }
    }

    if (!anyChanged) return { buffer, changed: false, applied: appliedIds };

    const encoded = new TextEncoder().encode(text).buffer;
    return { buffer: encoded, changed: true, applied: appliedIds };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 5. LOG STORE
  // ═══════════════════════════════════════════════════════════════════
  const logStore = (() => {
    const ring = [];
    const listeners = new Set();
    let seq = 0;

    function push(entry) {
      seq += 1;
      const rec = {
        id: seq,
        ts: Date.now(),
        method: (entry.method || 'GET').toUpperCase(),
        url: entry.url || '',
        status: entry.status || 0,
        statusText: entry.statusText || '',
        bytes: entry.bytes || 0,
        duration: entry.duration || 0,
        crossOrigin: !!entry.crossOrigin,
        blocked: !!entry.blocked,
        contentType: entry.contentType || '',
        reqHeaders: entry.reqHeaders || null,
        resHeaders: entry.resHeaders || null
      };
      ring.push(rec);
      if (ring.length > MAX_LOG) ring.shift();
      for (const fn of listeners) {
        try { fn(rec); } catch (e) {}
      }
      return rec;
    }

    function all() { return ring.slice(); }

    function clear() {
      ring.length = 0;
      for (const fn of listeners) {
        try { fn({ id: 0, __clear: true, ts: Date.now() }); } catch (e) {}
      }
    }

    function subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    return { push, all, clear, subscribe };
  })();

  // ═══════════════════════════════════════════════════════════════════
  // 6. HELPERS
  // ═══════════════════════════════════════════════════════════════════
  function parseGMHeaders(raw) {
    const out = {};
    if (!raw) return out;
    const lines = String(raw).split(/\r?\n/);
    for (const line of lines) {
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

  function isCrossOrigin(url) {
    try {
      const u = new URL(url, location.href);
      if (!/^https?:$/.test(u.protocol)) return false;
      return u.origin !== location.origin;
    } catch (e) {
      return false;
    }
  }

  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach((v, k) => { out[k] = v; });
      } else if (Array.isArray(h)) {
        for (const pair of h) {
          if (pair && pair.length >= 2) out[pair[0]] = pair[1];
        }
      } else if (typeof h === 'object') {
        for (const [k, v] of Object.entries(h)) out[k] = v;
      }
    } catch (e) {}
    return out;
  }

  async function bodyToGM(body) {
    if (body == null) return undefined;
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString();
    if (typeof FormData !== 'undefined' && body instanceof FormData) return body;
    if (typeof Blob !== 'undefined' && body instanceof Blob) return body;
    if (body instanceof ArrayBuffer) return body;
    if (ArrayBuffer.isView(body)) return body.buffer;
    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
      try {
        const reader = body.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.length;
          if (total > MAX_BODY) break;
        }
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.length; }
        return merged.buffer;
      } catch (e) {
        return undefined;
      }
    }
    try { return String(body); } catch (e) { return undefined; }
  }

  function makeResponse(status, statusText, headers, buffer) {
    const noBody = status === 204 || status === 205 || status === 304;
    const h = new Headers();
    for (const [k, v] of Object.entries(headers || {})) {
      try { h.set(k, String(v)); } catch (e) {}
    }
    if (noBody) {
      return new Response(null, { status, statusText, headers: h });
    }
    return new Response(buffer, { status, statusText, headers: h });
  }

  function shortUrl(u) {
    try {
      const p = new URL(u, location.href);
      const path = p.pathname.length > 60 ? p.pathname.slice(0, 60) + '…' : p.pathname;
      return p.hostname + path;
    } catch (e) {
      return String(u).slice(0, 80);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 7. CSP STRIPPER
  // ═══════════════════════════════════════════════════════════════════
  function installCSPStripper() {
    if (!settings.cspStrip) return;

    const killMetas = (root) => {
      if (!root || !root.querySelectorAll) return;
      let metas;
      try { metas = root.querySelectorAll('meta[http-equiv]'); } catch (e) { return; }
      for (const m of metas) {
        const eq = (m.getAttribute('http-equiv') || '').toLowerCase();
        if (eq === 'content-security-policy' || eq === 'content-security-policy-report-only') {
          try { m.remove(); } catch (e) {}
        }
      }
    };

    killMetas(document);
    killMetas(document.head);

    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (!n || n.nodeType !== 1) continue;
          if (n.tagName === 'META') {
            const eq = (n.getAttribute('http-equiv') || '').toLowerCase();
            if (eq === 'content-security-policy' || eq === 'content-security-policy-report-only') {
              try { n.remove(); } catch (e) {}
            }
          } else if (n.querySelectorAll) {
            killMetas(n);
          }
        }
      }
    });

    try {
      obs.observe(document, { childList: true, subtree: true });
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════════
  // 8. FRAME-BUSTER NEUTRALIZER
  // ═══════════════════════════════════════════════════════════════════
  function installFrameBuster() {
    if (!settings.frameBuster) return;
    if (window.top === window.self) return;

    // We're inside an iframe. Neutralize top/parent rebinding.
    try {
      Object.defineProperty(window, 'top', { value: window.self, configurable: true });
    } catch (e) {}
    try {
      Object.defineProperty(window, 'parent', { value: window.self, configurable: true });
    } catch (e) {}
    try {
      Object.defineProperty(window, 'frameElement', { value: null, configurable: true });
    } catch (e) {}

    // Kill onbeforeunload frame-busting redirects
    try {
      Object.defineProperty(window, 'onbeforeunload', { value: null, configurable: true, writable: true });
    } catch (e) {}

    // Best-effort: strip our own sandbox attribute
    try {
      const fe = window.frameElement;
      if (fe && fe.hasAttribute && fe.hasAttribute('sandbox')) {
        fe.removeAttribute('sandbox');
      }
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════════
  // 9. FETCH PATCH
  // ═══════════════════════════════════════════════════════════════════
  const nativeFetch = (typeof window.fetch === 'function') ? window.fetch.bind(window) : null;

  function installFetchPatch() {
    if (!settings.patchFetch || !nativeFetch) return;

    const ghostFetch = async function (input, init) {
      init = init || {};

      let url, method, reqHeaders = {}, body, credentials, signal, mode, cache, redirect, referrer, referrerPolicy;

      try {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          url = input.url;
          method = (init.method || input.method || 'GET').toUpperCase();
          reqHeaders = Object.assign({}, headersToObject(input.headers), headersToObject(init.headers));
          body = init.body !== undefined ? init.body : input.body;
          credentials = init.credentials || input.credentials || 'same-origin';
          signal = init.signal || input.signal;
          mode = init.mode || input.mode || 'cors';
          cache = init.cache || input.cache || 'default';
          redirect = init.redirect || input.redirect || 'follow';
          referrer = init.referrer !== undefined ? init.referrer : input.referrer;
          referrerPolicy = init.referrerPolicy || input.referrerPolicy;
        } else {
          url = String(input);
          method = (init.method || 'GET').toUpperCase();
          reqHeaders = headersToObject(init.headers);
          body = init.body;
          credentials = init.credentials || 'same-origin';
          signal = init.signal;
          mode = init.mode || 'cors';
          cache = init.cache || 'default';
          redirect = init.redirect || 'follow';
          referrer = init.referrer;
          referrerPolicy = init.referrerPolicy;
        }

        const absolute = new URL(url, location.href).href;

        // Same-origin → let native fetch handle it
        if (!isCrossOrigin(absolute)) {
          return nativeFetch(input, init);
        }

        const start = Date.now();
        const { headers: reqFinal } = applyRequestRules(absolute, reqHeaders);
        const gmBody = await bodyToGM(body);

        if (signal && signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        const resp = await new Promise((resolve, reject) => {
          const reqObj = gm.xhr({
            method,
            url: absolute,
            headers: reqFinal,
            data: gmBody,
            responseType: 'arraybuffer',
            timeout: 0,
            withCredentials: credentials === 'include',
            onload: (r) => resolve(r),
            onerror: (r) => reject(new Error('Ghost network error')),
            ontimeout: () => reject(new Error('Ghost timeout')),
            onabort: () => reject(new DOMException('Aborted', 'AbortError'))
          });

          if (signal) {
            const onAbort = () => {
              try { reqObj.abort(); } catch (e) {}
              reject(new DOMException('Aborted', 'AbortError'));
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
        });

        let buffer = null;
        if (resp.response instanceof ArrayBuffer) {
          buffer = resp.response;
        } else if (resp.response != null) {
          const enc = new TextEncoder().encode(String(resp.response));
          buffer = enc.buffer;
        } else {
          buffer = new ArrayBuffer(0);
        }

        const rawHeaders = parseGMHeaders(resp.responseHeaders);
        const contentType = rawHeaders['Content-Type'] || rawHeaders['content-type'] || '';

        const rewrite = await applyBodyRules(absolute, contentType, buffer);
        if (rewrite.changed) buffer = rewrite.buffer;

        const applied = applyResponseRules(absolute, rawHeaders);
        const duration = Date.now() - start;

        const response = makeResponse(
          resp.status || 200,
          resp.statusText || '',
          applied.headers,
          buffer
        );

        logStore.push({
          method,
          url: absolute,
          status: resp.status || 0,
          statusText: resp.statusText || '',
          bytes: buffer.byteLength,
          duration,
          crossOrigin: true,
          contentType,
          reqHeaders: reqFinal,
          resHeaders: applied.headers
        });

        return response;
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        if (settings.verbose && typeof console !== 'undefined') {
          console.warn('[ghost] fetch patch failed, falling back');
        }
        return nativeFetch(input, init);
      }
    };

    try {
      Object.defineProperty(window, 'fetch', {
        value: ghostFetch,
        configurable: true,
        writable: true
      });
    } catch (e) {
      window.fetch = ghostFetch;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 10. XHR PATCH
  // ═══════════════════════════════════════════════════════════════════
  const NativeXHR = window.XMLHttpRequest;

  function installXHRPatch() {
    if (!settings.patchXHR || !NativeXHR) return;

    class GhostXHR extends EventTarget {
      constructor() {
        super();
        this._m = 'GET';
        this._u = '';
        this._async = true;
        this._user = null;
        this._pw = null;
        this._reqHeaders = {};
        this._readyState = 0;
        this._status = 0;
        this._statusText = '';
        this._response = null;
        this._responseText = '';
        this._responseType = '';
        this._responseURL = '';
        this._withCredentials = false;
        this._timeout = 0;
        this._overrideMime = null;
        this._resHeaders = null;
        this._reqObj = null;
        this._running = false;

        // handler slots, populated by assignment
        this.onreadystatechange = null;
        this.onload = null;
        this.onerror = null;
        this.onprogress = null;
        this.onabort = null;
        this.onloadstart = null;
        this.onloadend = null;
        this.ontimeout = null;

        // Static event names for addEventListener users
        this.UNSENT = 0;
        this.OPENED = 1;
        this.HEADERS_RECEIVED = 2;
        this.LOADING = 3;
        this.DONE = 4;
      }

      get readyState() { return this._readyState; }
      get status() { return this._status; }
      get statusText() { return this._statusText; }
      get response() { return this._response; }
      get responseText() { return this._responseText; }
      get responseURL() { return this._responseURL; }

      get responseType() { return this._responseType; }
      set responseType(v) { this._responseType = String(v || ''); }

      get timeout() { return this._timeout; }
      set timeout(v) { this._timeout = Number(v) || 0; }

      get withCredentials() { return this._withCredentials; }
      set withCredentials(v) { this._withCredentials = !!v; }

      open(method, url, async, user, pw) {
        this._m = (method || 'GET').toUpperCase();
        this._u = String(url || '');
        this._async = async !== false;
        this._user = user != null ? user : null;
        this._pw = pw != null ? pw : null;
        this._readyState = 1;
        this._status = 0;
        this._statusText = '';
        this._response = null;
        this._responseText = '';
        this._responseURL = '';
        this._resHeaders = null;
        this._reqHeaders = {};
        this._running = false;
        this._fire('readystatechange');
      }

      setRequestHeader(name, value) {
        if (!name) return;
        this._reqHeaders[String(name)] = this._reqHeaders[String(name)]
          ? (this._reqHeaders[String(name)] + ', ' + String(value))
          : String(value);
      }

      getResponseHeader(name) {
        if (!this._resHeaders) return null;
        const target = String(name || '').toLowerCase();
        for (const [k, v] of Object.entries(this._resHeaders)) {
          if (k.toLowerCase() === target) return v;
        }
        return null;
      }

      getAllResponseHeaders() {
        if (!this._resHeaders) return '';
        return Object.entries(this._resHeaders)
          .map(([k, v]) => k + ': ' + v)
          .join('\r\n');
      }

      overrideMimeType(mime) {
        this._overrideMime = String(mime || '');
      }

      abort() {
        this._running = false;
        if (this._reqObj && this._reqObj.abort) {
          try { this._reqObj.abort(); } catch (e) {}
        }
        try {
          this._fire('abort');
          this._fire('loadend');
        } catch (e) {}
        this._readyState = 4;
        this._fire('readystatechange');
      }

      _fire(type) {
        const evt = { type, target: this, currentTarget: this, timeStamp: Date.now() };

        const handler = this['on' + type];
        if (typeof handler === 'function') {
          try { handler.call(this, evt); } catch (e) {
            if (settings.verbose) console.error('[ghost] xhr handler threw', e);
          }
        }

        try {
          super.dispatchEvent(Object.assign(new Event(type), evt));
        } catch (e) {}
      }

      send(body) {
        const self = this;
        const absolute = new URL(this._u, location.href).href;

        // Same-origin → hand off to native XHR
        if (!isCrossOrigin(absolute)) {
          const x = new NativeXHR();
          x.open(this._m, absolute, this._async, this._user, this._pw);
          if (this._responseType) x.responseType = this._responseType;
          x.withCredentials = this._withCredentials;
          if (this._timeout) x.timeout = this._timeout;
          for (const [k, v] of Object.entries(this._reqHeaders)) {
            try { x.setRequestHeader(k, v); } catch (e) {}
          }
          if (this._overrideMime) x.overrideMimeType(this._overrideMime);

          x.onreadystatechange = () => {
            self._readyState = x.readyState;
            self._status = x.status;
            self._statusText = x.statusText;
            self._response = x.response;
            self._responseText = x.responseText;
            self._responseURL = x.responseURL || absolute;
            self._resHeaders = parseGMHeaders(x.getAllResponseHeaders());
            self._fire('readystatechange');
          };
          x.onload = () => self._fire('load');
          x.onerror = () => self._fire('error');
          x.onabort = () => self._fire('abort');
          x.ontimeout = () => self._fire('timeout');
          x.onloadend = () => self._fire('loadend');

          this._reqObj = x;
          this._running = true;
          x.send(body == null ? null : body);
          return;
        }

        // Cross-origin → GM route
        this._running = true;
        this._readyState = 1;
        this._fire('readystatechange');
        this._fire('loadstart');

        const start = Date.now();
        const { headers: reqFinal } = applyRequestRules(absolute, this._reqHeaders);

        Promise.resolve(bodyToGM(body)).then((gmBody) => {
          const reqObj = gm.xhr({
            method: this._m,
            url: absolute,
            headers: reqFinal,
            data: gmBody,
            responseType: 'arraybuffer',
            timeout: this._timeout || 0,
            withCredentials: this._withCredentials,
            onload: async (r) => {
              if (!self._running) return;

              self._readyState = 2;
              self._fire('readystatechange');

              let buffer = null;
              if (r.response instanceof ArrayBuffer) buffer = r.response;
              else if (r.response != null) buffer = new TextEncoder().encode(String(r.response)).buffer;
              else buffer = new ArrayBuffer(0);

              const rawHeaders = parseGMHeaders(r.responseHeaders);
              const contentType = rawHeaders['Content-Type'] || rawHeaders['content-type'] || '';

              validBody = await applyBodyRules(absolute, contentType, buffer);
              if (validBody.changed) buffer = validBody.buffer;

              const applied = applyResponseRules(absolute, rawHeaders);

              self._readyState = 3;
              self._fire('readystatechange');

              let finalBuffer = buffer;
              if (self._overrideMime || (self._responseType && self._responseType !== 'arraybuffer' && self._responseType !== 'blob')) {
                // no-op, buffer stays
              }

              try {
                if (self._responseType === 'blob') {
                  self._response = new Blob([finalBuffer]);
                  self._responseText = '';
                } else if (self._responseType === 'arraybuffer') {
                  self._response = finalBuffer;
                  self._responseText = '';
                } else if (self._responseType === 'json') {
                  try {
                    self._responseText = new TextDecoder('utf-8').decode(new Uint8Array(finalBuffer));
                    self._response = JSON.parse(self._responseText);
                  } catch (e) {
                    self._response = null;
                    self._responseText = '';
                  }
                } else {
                  self._responseText = new TextDecoder('utf-8').decode(new Uint8Array(finalBuffer));
                  self._response = self._responseText;
                }
              } catch (e) {
                self._response = finalBuffer;
                self._responseText = '';
              }

              self._status = r.status || 200;
              self._statusText = r.statusText || '';
              self._responseURL = absolute;
              self._resHeaders = applied.headers;
              self._readyState = 4;

              logStore.push({
                method: self._m,
                url: absolute,
                status: self._status,
                statusText: self._statusText,
                bytes: encodeURIComponent(self._responseText || '').length,
                duration: Date.now() - start,
                crossOrigin: true,
                contentType,
                reqHeaders: reqFinal,
                resHeaders: applied.headers
              });

              self._fire('readystatechange');
              self._fire('load');
              self._fire('loadend');
              self._running = false;
            },
            onerror: () => {
              if (!self._running) return;
              self._status = 0;
              self._readyState = 4;
              logStore.push({
                method: self._m,
                url: absolute,
                status: 0,
                blocked: true,
                duration: Date.now() - start,
                crossOrigin: true,
                reqHeaders: reqFinal
              });
              self._fire('readystatechange');
              self._fire('error');
              self._fire('loadend');
              self._running = false;
            },
            ontimeout: () => {
              if (!self._running) return;
              self._status = 0;
              self._readyState = 4;
              self._fire('readystatechange');
              self._fire('timeout');
              self._fire('loadend');
              self._running = false;
            },
            onabort: () => {
              if (!self._running) return;
              self._status = 0;
              self._readyState = 4;
              self._fire('readystatechange');
              self._fire('abort');
              self._fire('loadend');
              self._running = false;
            }
          });

          self._reqObj = reqObj;
        }).catch(() => {
          self._fire('error');
          self._fire('loadend');
        });
      }
    }

    try {
      Object.defineProperty(window, 'XMLHttpRequest', {
        value: GhostXHR,
        configurable: true,
        writable: true
      });
    } catch (e) {
      window.XMLHttpRequest = GhostXHR;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 11. HAR EXPORT
  // ═══════════════════════════════════════════════════════════════════
  function buildHAR(entries) {
    const filtered = entries.filter((e) => e && !e.__clear && e.url);
    return {
      log: {
        version: '1.2',
        creator: { name: 'Ghost', version: '1.0.0' },
        browser: { name: 'Ghost', version: '1.0.0' },
        pages: [{
          startedDateTime: filtered.length ? new Date(filtered[0].ts).toISOString() : new Date().toISOString(),
          id: 'page_1',
          title: document.title || 'Ghost session',
          pageTimings: { onContentLoad: -1, onLoad: -1 }
        }],
        entries: filtered.map((rec) => {
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
                try {
                  const u = new URL(rec.url);
                  return [...u.searchParams.entries()].map(([name, value]) => ({ name, value }));
                } catch (e) { return []; }
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
              content: {
                size: rec.bytes || 0,
                mimeType: rec.contentType || 'application/octet-stream',
                text: ''
              },
              redirectURL: '',
              headersSize: -1,
              bodySize: rec.bytes || 0
            },
            cache: {},
            timings: { send: 0, wait: rec.duration || 0, receive: 0 },
            _ghost: {
              id: rec.id,
              crossOrigin: !!rec.crossOrigin,
              blocked: !!rec.blocked
            }
          };
        })
      }
    };
  }

  function exportHAR() {
    const har = buildHAR(logStore.all());
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
    }, 500);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 12. HUD — the little floating panel
  // ═══════════════════════════════════════════════════════════════════
  function mountHUD() {
    if (document.getElementById('ghost-hud-root')) return;

    const root = document.createElement('div');
    root.id = 'ghost-hud-root';
    root.innerHTML = `
      <div id="ghost-hud-toggle" title="Ghost (Ctrl+Shift+G)">G</div>
      <div id="ghost-hud" hidden>
        <div class="gh-head">
          <span class="gh-dot"></span>
          <span class="gh-title">ghost</span>
          <span class="gh-spacer"></span>
          <button class="gh-x" id="ghost-close">×</button>
        </div>
        <div class="gh-tabs">
          <button class="gh-tab active" data-pane="requests">requests</button>
          <button class="gh-tab" data-pane="rules">headers</button>
          <button class="gh-tab" data-pane="body">body</button>
          <button class="gh-tab" data-pane="settings">settings</button>
        </div>
        <div class="gh-pane active" data-pane="requests">
          <div class="gh-bar">
            <input id="ghost-filter" placeholder="filter url / status">
            <button id="ghost-har" class="gh-btn">har</button>
            <button id="ghost-clearlog" class="gh-btn">clear</button>
          </div>
          <div class="gh-stats" id="ghost-stats">0 requests</div>
          <div class="gh-list" id="ghost-loglist"></div>
        </div>
        <div class="gh-pane" data-pane="rules">
          <div class="gh-bar">
            <button id="ghost-hr-new" class="gh-btn">new</button>
            <button id="ghost-hr-reset" class="gh-btn">reset</button>
          </div>
          <div class="gh-list" id="ghost-hr-list"></div>
        </div>
        <div class="gh-pane" data-pane="body">
          <div class="gh-bar">
            <button id="ghost-br-new" class="gh-btn">new</button>
            <button id="ghost-br-reset" class="gh-btn">reset</button>
          </div>
          <div class="gh-list" id="ghost-br-list"></div>
        </div>
        <div class="gh-pane" data-pane="settings">
          <div class="gh-settings" id="ghost-settings"></div>
        </div>
        <div class="gh-detail" id="ghost-detail" hidden></div>
      </div>
    `;
    document.documentElement.appendChild(root);

    const style = document.createElement('style');
    style.textContent = `
      #ghost-hud-root, #ghost-hud-root * {
        box-sizing: border-box;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
      }
      #ghost-hud-toggle {
        position: fixed; right: 12px; bottom: 12px;
        width: 34px; height: 34px; border-radius: 10px;
        background: rgba(15,18,22,.95); color: #e6e8eb;
        border: 1px solid #1c2027; display: flex;
        align-items: center; justify-content: center;
        font-weight: 600; cursor: pointer; z-index: 2147483646;
        box-shadow: 0 8px 24px rgba(0,0,0,.5);
        user-select: none;
      }
      #ghost-hud-toggle:hover { background: #1c2027; color: #3b82f6; }
      #ghost-hud {
        position: fixed; right: 12px; bottom: 56px;
        width: 480px; max-width: calc(100vw - 24px);
        height: 520px; max-height: calc(100vh - 96px);
        background: rgba(11,13,16,.98); color: #e6e8eb;
        border: 1px solid #1c2027; border-radius: 12px;
        display: flex; flex-direction: column; overflow: hidden;
        z-index: 2147483647;
        box-shadow: 0 24px 60px rgba(0,0,0,.7);
        backdrop-filter: blur(12px);
      }
      #ghost-hud[hidden] { display: none; }
      #ghost-hud .gh-head {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 12px; border-bottom: 1px solid #171a1f;
        background: #0f1216;
      }
      #ghost-hud .gh-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #10b981; box-shadow: 0 0 8px #10b981;
      }
      #ghost-hud .gh-title { color: #e6e8eb; font-weight: 600; letter-spacing: .5px; }
      #ghost-hud .gh-spacer { flex: 1; }
      #ghost-hud .gh-x {
        background: transparent; border: none; color: #5a636e;
        font-size: 18px; cursor: pointer; padding: 0 4px; border-radius: 4px;
      }
      #ghost-hud .gh-x:hover { background: #1c2027; color: #e6e8eb; }
      #ghost-hud .gh-tabs {
        display: flex; gap: 2px; padding: 6px 8px 0;
        border-bottom: 1px solid #171a1f;
      }
      #ghost-hud .gh-tab {
        background: transparent; border: none; color: #5a636e;
        padding: 6px 12px; border-radius: 6px 6px 0 0;
        cursor: pointer; font: inherit;
      }
      #ghost-hud .gh-tab.active { background: #14171c; color: #e6e8eb; }
      #ghost-hud .gh-tab:hover:not(.active) { color: #9aa3ad; }
      #ghost-hud .gh-pane {
        display: none; flex: 1; min-height: 0;
        flex-direction: column;
      }
      #ghost-hud .gh-pane.active { display: flex; }
      #ghost-hud .gh-bar {
        display: flex; gap: 6px; padding: 8px;
        border-bottom: 1px solid #171a1f;
      }
      #ghost-hud input {
        flex: 1; background: #14171c; border: 1px solid #1c2027;
        border-radius: 6px; padding: 0 10px; height: 26px;
        color: #e6e8eb; font: inherit; outline: none; min-width: 0;
      }
      #ghost-hud input:focus { border-color: #3b82f6; }
      #ghost-hud .gh-btn {
        background: #14171c; color: #9aa3ad;
        border: 1px solid #1c2027; border-radius: 6px;
        padding: 0 12px; height: 26px; cursor: pointer; font: inherit;
      }
      #ghost-hud .gh-btn:hover { background: #1c2027; color: #e6e8eb; }
      #ghost-hud .gh-stats {
        padding: 6px 12px; color: #5a636e;
        border-bottom: 1px solid #171a1f;
      }
      #ghost-hud .gh-list {
        flex: 1; overflow-y: auto; min-height: 0;
      }
      #ghost-hud .gh-list::-webkit-scrollbar { width: 8px; }
      #ghost-hud .gh-list::-webkit-scrollbar-thumb {
        background: #1c2027; border-radius: 4px;
      }
      #ghost-hud .gh-row {
        display: grid; grid-template-columns: 42px 40px 1fr;
        gap: 8px; padding: 4px 10px;
        border-bottom: 1px solid #101318;
        cursor: pointer; color: #9aa3ad; white-space: nowrap;
      }
      #ghost-hud .gh-row:hover { background: #101318; color: #e6e8eb; }
      #ghost-hud .gh-row .m { color: #5a636e; }
      #ghost-hud .gh-row .u { overflow: hidden; text-overflow: ellipsis; }
      #ghost-hud .gh-row.s2 .s { color: #10b981; }
      #ghost-hud .gh-row.s3 .s { color: #eab308; }
      #ghost-hud .gh-row.s4 .s { color: #f59e0b; }
      #ghost-hud .gh-row.s5 .s { color: #ef4444; }
      #ghost-hud .gh-row.s0 .s { color: #4b5563; }
      #ghost-hud .gh-rule {
        background: #0f1216; border: 1px solid #171a1f;
        border-radius: 8px; padding: 10px; margin: 8px;
      }
      #ghost-hud .gh-rule.dis { opacity: .5; }
      #ghost-hud .gh-rule .rh {
        display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
      }
      #ghost-hud .gh-rule .rid {
        flex: 1; background: transparent; border: none;
        color: #5a636e; font: inherit; outline: none;
      }
      #ghost-hud .gh-rule .rdel {
        background: transparent; border: none; color: #5a636e;
        font-size: 16px; cursor: pointer; padding: 0 6px; border-radius: 4px;
      }
      #ghost-hud .gh-rule .rdel:hover { background: #1c2027; color: #ef4444; }
      #ghost-hud .gh-rule label {
        display: flex; flex-direction: column; gap: 3px;
        color: #5a636e; font-size: 10px; text-transform: uppercase;
        letter-spacing: .5px; margin-bottom: 6px;
      }
      #ghost-hud .gh-rule input,
      #ghost-hud .gh-rule select,
      #ghost-hud .gh-rule textarea {
        background: #14171c; border: 1px solid #1c2027;
        border-radius: 5px; padding: 5px 8px;
        color: #e6e8eb; font: inherit; outline: none;
        width: 100%; resize: vertical;
      }
      #ghost-hud .gh-rule input:focus,
      #ghost-hud .gh-rule textarea:focus { border-color: #3b82f6; }
      #ghost-hud .gh-settings {
        padding: 12px; display: flex; flex-direction: column; gap: 10px;
      }
      #ghost-hud .gh-setting {
        display: flex; align-items: center; justify-content: space-between;
        padding: 8px 10px; background: #0f1216;
        border: 1px solid #171a1f; border-radius: 8px;
      }
      #ghost-hud .gh-setting span { color: #9aa3ad; }
      #ghost-hud .gh-setting input[type=checkbox] {
        width: auto; flex: 0 0 auto; accent-color: #3b82f6;
      }
      #ghost-hud .gh-detail {
        position: absolute; inset: 0;
        background: rgba(11,13,16,.98);
        display: flex; flex-direction: column;
        overflow: hidden;
      }
      #ghost-hud .gh-detail[hidden] { display: none; }
      #ghost-hud .gh-detail .dh {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 12px; border-bottom: 1px solid #171a1f;
        background: #0f1216;
      }
      #ghost-hud .gh-detail .durl {
        padding: 8px 12px; color: #9aa3ad;
        border-bottom: 1px solid #171a1f;
        word-break: break-all; background: #0f1216;
      }
      #ghost-hud .gh-detail pre {
        margin: 0; padding: 10px 12px;
        color: #9aa3ad; white-space: pre-wrap;
        word-break: break-all; overflow-y: auto;
        background: #101318; border-radius: 6px;
        margin: 8px 12px;
      }
      #ghost-hud .gh-detail .dlabel {
        padding: 8px 12px 0; color: #5a636e;
        text-transform: uppercase; letter-spacing: .5px;
        font-size: 10px;
      }
    `;
    document.documentElement.appendChild(style);

    // ── wiring ──
    const toggle = root.querySelector('#ghost-hud-toggle');
    const hud = root.querySelector('#ghost-hud');
    const closeBtn = root.querySelector('#ghost-close');
    const filterEl = root.querySelector('#ghost-filter');
    const logList = root.querySelector('#ghost-loglist');
    const statsEl = root.querySelector('#ghost-stats');
    const detail = root.querySelector('#ghost-detail');
    const hrList = root.querySelector('#ghost-hr-list');
    const brList = root.querySelector('#ghost-br-list');
    const settingsPane = root.querySelector('#ghost-settings');

    function openHUD() {
      hud.hidden = false;
      settings.hudVisible = true;
      saveSettings();
      renderLog();
    }
    function closeHUD() {
      hud.hidden = true;
      settings.hudVisible = false;
      saveSettings();
      detail.hidden = true;
    }
    function toggleHUD() { hud.hidden ? openHUD() : closeHUD(); }

    toggle.addEventListener('click', toggleHUD);
    closeBtn.addEventListener('click', closeHUD);

    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'G' || e.key === 'g')) {
        e.preventDefault();
        toggleHUD();
      }
    }, true);

    // pane switching
    const tabsEls = root.querySelectorAll('.gh-tab');
    const panes = root.querySelectorAll('.gh-pane');
    tabsEls.forEach((t) => {
      t.addEventListener('click', () => {
        tabsEls.forEach((x) => x.classList.remove('active'));
        panes.forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        const pane = root.querySelector('.gh-pane[data-pane="' + t.dataset.pane + '"]');
        if (pane) pane.classList.add('active');
      });
    });

    // ── request log render ──
    let filter = '';
    let cachedLog = [];

    function statusClass(code) {
      if (code >= 500) return 's5';
      if (code >= 400) return 's4';
      if (code >= 300) return 's3';
      if (code >= 200) return 's2';
      return 's0';
    }

    function renderLog() {
      const f = filter.toLowerCase();
      const visible = cachedLog.filter((r) => {
        if (!f) return true;
        return (r.url || '').toLowerCase().includes(f) ||
               String(r.status || '').includes(f) ||
               (r.method || '').toLowerCase().includes(f);
      });

      logList.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (const r of visible.slice(-400)) {
        const el = document.createElement('div');
        el.className = 'gh-row ' + statusClass(r.status);
        el.dataset.id = r.id;
        el.innerHTML =
          '<span class="m">' + (r.method || 'GET') + '</span>' +
          '<span class="s">' + (r.status || '···') + '</span>' +
          '<span class="u" title="' + r.url + '">' + shortUrl(r.url) + '</span>';
        el.addEventListener('click', () => showDetail(r));
        frag.appendChild(el);
      }
      logList.appendChild(frag);
      logList.scrollTop = logList.scrollHeight;

      const s = cachedLog.reduce((a, r) => {
        a.total++;
        if (r.status >= 400) a.err++;
        if (r.blocked) a.blocked++;
        return a;
      }, { total: 0, err: 0, blocked: 0 });
      statsEl.textContent = s.total + ' total · ' + s.err + ' errors · ' + s.blocked + ' blocked';
    }

    function showDetail(rec) {
      const fmt = (o) => {
        if (!o) return '(none)';
        return Object.entries(o).map(([k, v]) => k + ': ' + v).join('\n');
      };
      detail.innerHTML =
        '<div class="dh">' +
          '<span class="m" style="color:#3b82f6">' + (rec.method || 'GET') + '</span>' +
          '<span class="s" style="color:#10b981">' + (rec.status || '···') + '</span>' +
          '<span class="gh-spacer" style="flex:1"></span>' +
          '<button class="gh-btn" id="ghost-det-close">close</button>' +
        '</div>' +
        '<div class="durl">' + (rec.url || '') + '</div>' +
        '<div class="dlabel">request headers</div>' +
        '<pre>' + fmt(rec.reqHeaders) + '</pre>' +
        '<div class="dlabel">response headers</div>' +
        '<pre>' + fmt(rec.resHeaders) + '</pre>' +
        '<div class="dlabel">meta</div>' +
        '<pre>' +
          'duration:    ' + (rec.duration || 0) + 'ms\n' +
          'bytes:       ' + (rec.bytes || 0) + '\n' +
          'content-type:' + (rec.contentType || '—') + '\n' +
          'cross-origin:' + (rec.crossOrigin ? 'yes' : 'no') + '\n' +
          'blocked:     ' + (rec.blocked ? 'yes' : 'no') + '\n' +
          'time:        ' + new Date(rec.ts).toLocaleTimeString() +
        '</pre>';
      detail.hidden = false;
      detail.querySelector('#ghost-det-close').addEventListener('click', () => { detail.hidden = true; });
    }

    filterEl.addEventListener('input', () => { filter = filterEl.value; renderLog(); });

    root.querySelector('#ghost-clearlog').addEventListener('click', () => {
      logStore.clear();
      cachedLog = [];
      renderLog();
    });

    root.querySelector('#ghost-har').addEventListener('click', exportHAR);

    // live log stream
    logStore.subscribe((rec) => {
      if (rec && rec.__clear) { cachedLog = []; renderLog(); return; }
      cachedLog.push(rec);
      if (cachedLog.length > MAX_LOG) cachedLog.shift();
      if (!hud.hidden) renderLog();
    });

    cachedLog = logStore.all();
    renderLog();

    // ── header rules pane ──
    function renderHeaderRules() {
      hrList.innerHTML = '';
      for (const r of headerRules) {
        const el = document.createElement('div');
        el.className = 'gh-rule' + (r.enabled ? '' : ' dis');
        el.dataset.id = r.id;
        el.innerHTML =
          '<div class="rh">' +
            '<input type="checkbox" ' + (r.enabled ? 'checked' : '') + ' data-act="toggle" style="width:auto;flex:0 0 auto">' +
            '<input class="rid" value="' + r.id + '" readonly>' +
            '<button class="rdel" title="delete">×</button>' +
          '</div>' +
          '<label>match<input class="r-match" value="' + String(r.match || '').replace(/"/g, '&quot;') + '"></label>' +
          '<label>phase<select class="r-phase">' +
            '<option value="request"' + (r.phase === 'request' ? ' selected' : '') + '>request</option>' +
            '<option value="response"' + (r.phase === 'response' ? ' selected' : '') + '>response</option>' +
            '<option value="both"' + (r.phase === 'both' ? ' selected' : '') + '>both</option>' +
          '</select></label>' +
          '<label>set (json)<textarea class="r-set" rows="2">' + JSON.stringify(r.set || {}) + '</textarea></label>' +
          '<label>remove (comma list)<input class="r-remove" value="' + (r.remove || []).join(', ') + '"></label>';

        el.querySelector('[data-act="toggle"]').addEventListener('change', (e) => {
          updateHeaderRule(r.id, { enabled: e.target.checked });
          el.classList.toggle('dis', !e.target.checked);
        });
        el.querySelector('.rdel').addEventListener('click', () => {
          removeHeaderRule(r.id);
          renderHeaderRules();
        });

        const commit = () => {
          let setObj = {};
          try { setObj = JSON.parse(el.querySelector('.r-set').value || '{}'); } catch (e) {}
          const removeArr = el.querySelector('.r-remove').value.split(',').map((s) => s.trim()).filter(Boolean);
          updateHeaderRule(r.id, {
            match: el.querySelector('.r-match').value,
            phase: el.querySelector('.r-phase').value,
            set: setObj,
            remove: removeArr
          });
        };
        el.querySelector('.r-match').addEventListener('blur', commit);
        el.querySelector('.r-phase').addEventListener('change', commit);
        el.querySelector('.r-set').addEventListener('blur', commit);
        el.querySelector('.r-remove').addEventListener('blur', commit);

        hrList.appendChild(el);
      }
    }

    root.querySelector('#ghost-hr-new').addEventListener('click', () => {
      addHeaderRule({ id: '', enabled: true, match: '.*', phase: 'both', set: {}, remove: [] });
      renderHeaderRules();
    });
    root.querySelector('#ghost-hr-reset').addEventListener('click', () => {
      resetHeaderRules();
      renderHeaderRules();
    });
    renderHeaderRules();

    // ── body rules pane ──
    function renderBodyRules() {
      brList.innerHTML = '';
      for (const r of bodyRules) {
        const el = document.createElement('div');
        el.className = 'gh-rule' + (r.enabled ? '' : ' dis');
        el.dataset.id = r.id;
        el.innerHTML =
          '<div class="rh">' +
            '<input type="checkbox" ' + (r.enabled ? 'checked' : '') + ' data-act="toggle" style="width:auto;flex:0 0 auto">' +
            '<input class="rid" value="' + r.id + '" readonly>' +
            '<button class="rdel" title="delete">×</button>' +
          '</div>' +
          '<label>match<input class="r-match" value="' + String(r.match || '').replace(/"/g, '&quot;') + '"></label>' +
          '<label>content-type<input class="r-ct" value="' + String(r.contentType || '').replace(/"/g, '&quot;') + '"></label>' +
          '<label>mode<select class="r-mode">' +
            '<option value="json"' + (r.mode === 'json' ? ' selected' : '') + '>json</option>' +
            '<option value="text"' + (r.mode === 'text' ? ' selected' : '') + '>text</option>' +
          '</select></label>' +
          '<label>order<input class="r-order" type="number" value="' + (r.order || 100) + '"></label>' +
          '<label>transform — (data) =&gt; data<textarea class="r-xf" rows="4">' +
            String(r.transform || '').replace(/</g, '&lt;') +
          '</textarea></label>';

        el.querySelector('[data-act="toggle"]').addEventListener('change', (e) => {
          updateBodyRule(r.id, { enabled: e.target.checked });
          el.classList.toggle('dis', !e.target.checked);
        });
        el.querySelector('.rdel').addEventListener('click', () => {
          removeBodyRule(r.id);
          renderBodyRules();
        });

        const commit = () => {
          updateBodyRule(r.id, {
            match: el.querySelector('.r-match').value,
            contentType: el.querySelector('.r-ct').value,
            mode: el.querySelector('.r-mode').value,
            order: parseInt(el.querySelector('.r-order').value, 10) || 100,
            transform: el.querySelector('.r-xf').value
          });
        };
        el.querySelector('.r-match').addEventListener('blur', commit);
        el.querySelector('.r-ct').addEventListener('blur', commit);
        el.querySelector('.r-mode').addEventListener('change', commit);
        el.querySelector('.r-order').addEventListener('blur', commit);
        el.querySelector('.r-xf').addEventListener('blur', commit);

        brList.appendChild(el);
      }
    }

    root.querySelector('#ghost-br-new').addEventListener('click', () => {
      addBodyRule({
        id: '',
        enabled: true,
        match: '.*/api/.*',
        contentType: 'application/json',
        mode: 'json',
        order: 100,
        transform: 'return data;'
      });
      renderBodyRules();
    });
    root.querySelector('#ghost-br-reset').addEventListener('click', () => {
      resetBodyRules();
      renderBodyRules();
    });
    renderBodyRules();

    // ── settings pane ──
    function renderSettings() {
      settingsPane.innerHTML = '';
      const items = [
        ['cspStrip', 'strip csp meta tags'],
        ['frameBuster', 'neutralize frame-busters'],
        ['patchFetch', 'patch window.fetch'],
        ['patchXHR', 'patch XMLHttpRequest'],
        ['verbose', 'verbose console logs']
      ];
      for (const [key, label] of items) {
        const row = document.createElement('div');
        row.className = 'gh-setting';
        row.innerHTML = '<span>' + label + '</span>' +
          '<input type="checkbox" ' + (settings[key] ? 'checked' : '') + '>';
        row.querySelector('input').addEventListener('change', (e) => {
          settings[key] = e.target.checked;
          saveSettings();
        });
        settingsPane.appendChild(row);
      }

      const info = document.createElement('div');
      info.className = 'gh-setting';
      info.innerHTML = '<span>rules</span><span style="color:#e6e8eb">' +
        headerRules.length + ' headers · ' + bodyRules.length + ' bodies</span>';
      settingsPane.appendChild(info);

      const wipe = document.createElement('div');
      wipe.className = 'gh-setting';
      wipe.innerHTML = '<span>reset everything</span>';
      const btn = document.createElement('button');
      btn.className = 'gh-btn';
      btn.textContent = 'wipe';
      btn.addEventListener('click', () => {
        for (const k of gm.list()) {
          if (String(k).startsWith('ghost:')) gm.del(k);
        }
        gm.notify('cleared. reload the page.', 'Ghost');
      });
      wipe.appendChild(btn);
      settingsPane.appendChild(wipe);
    }
    renderSettings();

    // initial visibility
    if (settings.hudVisible) openHUD();
  }

  // ═══════════════════════════════════════════════════════════════════
  // 13. CONTEXT MENU COMMANDS
  // ═══════════════════════════════════════════════════════════════════
  function registerMenus() {
    gm.menu('Ghost: toggle HUD (Ctrl+Shift+G)', () => {
      const hud = document.getElementById('ghost-hud');
      const toggle = document.getElementById('ghost-hud-toggle');
      if (toggle) toggle.click();
      else if (hud) hud.hidden = !hud.hidden;
    });

    gm.menu('Ghost: export HAR', () => {
      exportHAR();
    });

    gm.menu('Ghost: clear request log', () => {
      logStore.clear();
    });

    gm.menu('Ghost: reset header rules', () => {
      resetHeaderRules();
      gm.notify('header rules reset', 'Ghost');
    });

    gm.menu('Ghost: reset body rules', () => {
      resetBodyRules();
      gm.notify('body rules reset', 'Ghost');
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 14. BOOT
  // ═══════════════════════════════════════════════════════════════════
  function boot() {
    installCSPStripper();
    installFrameBuster();
    installFetchPatch();
    installXHRPatch();
    registerMenus();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mountHUD, { once: true });
    } else {
      mountHUD();
    }

    if (settings.verbose) {
      console.log('[ghost] active — cors bypass on, csp strip on, ' +
        headerRules.length + ' header rules, ' + bodyRules.length + ' body rules');
    }
  }

  boot();

  // expose for debugging from the page console
  try {
    PAGE.__ghost = {
      log: logStore.all.bind(logStore),
      clear: logStore.clear.bind(logStore),
      headerRules: () => headerRules,
      bodyRules: () => bodyRules,
      settings: () => settings,
      exportHAR
    };
  } catch (e) {}
})();