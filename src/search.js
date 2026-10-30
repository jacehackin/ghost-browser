// src/search.js
'use strict';

const history = require('./history');
const bookmarks = require('./bookmarks');

const ENGINES = {
  duckduckgo: (q) => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
  google:     (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q),
  bing:       (q) => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
  brave:      (q) => 'https://search.brave.com/search?q=' + encodeURIComponent(q),
  startpage:  (q) => 'https://www.startpage.com/sp/search?query=' + encodeURIComponent(q)
};

function looksLikeUrl(q) {
  if (!q) return false;
  if (/\s/.test(q)) return false;
  if (/^(https?|ftp|file):\/\//i.test(q)) return true;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(q)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(q)) return true;
  if (/^[\w-]+(\.[\w-]+){1,}(:\d+)?(\/.*)?$/.test(q)) return true;
  return false;
}

function normalizeInputToUrl(q) {
  if (/^(https?|ftp|file):\/\//i.test(q)) return q;
  if (/^localhost/i.test(q)) return 'http://' + q;
  return 'https://' + q;
}

function scoreEntry(query, entry) {
  const q = query.toLowerCase();
  const url = (entry.url || '').toLowerCase();
  const title = (entry.title || '').toLowerCase();

  let host = '';
  try { host = new URL(entry.url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) {}

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
    for (const c of hay) {
      if (c === q[i]) i += 1;
      if (i === q.length) break;
    }
    s = (i === q.length) ? 400 : Infinity;
  }

  if (s === Infinity) return Infinity;

  if (entry.ts) {
    const ageDays = (Date.now() - entry.ts) / 86400000;
    s -= Math.max(0, 60 - ageDays * 1.5);
  }
  if (entry.bookmark) s -= 50;
  if (entry.visits) s -= Math.min(40, entry.visits * 2);

  return s;
}

function buildIndex() {
  const h = history.all().slice(-3000);
  const b = bookmarks.list();

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
  return out;
}

function subset(u) {
  try {
    const x = new URL(u);
    const p = x.pathname.length > 44 ? x.pathname.slice(0, 44) + '…' : x.pathname;
    return x.hostname.replace(/^www\./, '') + (p === '/' ? '' : p);
  } catch (e) {
    return String(u).slice(0, 70);
  }
}

function query(q, limit = 8, engine = 'duckduckgo') {
  q = String(q || '').trim();

  if (!q) {
    const idx = buildIndex();
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
    results.push({
      type: 'url',
      title: q,
      url: normalizeInputToUrl(q),
      subtitle: 'open',
      score: -100
    });
  }

  const idx = buildIndex();
  const scored = [];
  for (const e of idx) {
    const s = scoreEntry(q, e);
    if (s === Infinity) continue;
    scored.push({ e, s });
  }
  scored.sort((a, b) => a.s - b.s);

  const remaining = Math.max(1, limit - results.length - 1);
  for (const { e, s } of scored.slice(0, remaining)) {
    results.push({
      type: e.bookmark ? 'bookmark' : 'history',
      title: e.title || e.url,
      url: e.url,
      subtitle: subset(e.url),
      score: s
    });
  }

  const fn = ENGINES[engine] || ENGINES.duckduckgo;
  results.push({
    type: 'search',
    title: q,
    url: fn(q),
    subtitle: 'search · ' + engine,
    score: 900
  });

  return results.slice(0, limit);
}

module.exports = {
  query,
  buildIndex,
  looksLikeUrl,
  normalizeInputToUrl,
  ENGINES
};