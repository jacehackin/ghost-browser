// src/history.js
'use strict';

const fs = require('fs');
const path = require('path');
const {
  app
} = require('electron');

const FILE = path.join(app.getPath('userData'), 'history.json');
const MAX = 10000;

let entries = null;
let dirty = false;
let flushTimer = null;

function load() {
  if (entries) return entries;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    entries = [];
  }
  return entries;
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 800);
}

function flush() {
  flushTimer = null;
  if (!dirty || !entries) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(entries), 'utf8');
  } catch (e) { /* non-fatal */ }
}

function normalizeUrl(u) {
  if (!u) return '';
  try {
    const x = new URL(u);
    x.hash = '';
    return x.href;
  } catch (e) {
    return String(u);
  }
}

function add({ url, title, ts }) {
  if (!url) return null;
  if (/^(ghost|about|chrome|devtools|data|blob|javascript):/i.test(url)) return null;
  const norm = normalizeUrl(url);
  if (!norm) return null;

  const list = load();
  const last = list[list.length - 1];
  const stamp = ts || Date.now();

  if (last && last.url === norm) {
    last.ts = stamp;
    last.visits = (last.visits || 1) + 1;
    if (title) last.title = String(title).slice(0, 256);
    scheduleFlush();
    return last;
  }

  const entry = {
    url: norm,
    title: String(title || '').slice(0, 256),
    ts: stamp,
    visits: 1
  };
  list.push(entry);
  if (list.length > MAX) list.splice(0, list.length - MAX);
  scheduleFlush();
  return entry;
}

function recent(limit = 100) {
  const list = load();
  return list.slice(-limit).reverse();
}

function all() {
  return load().slice();
}

function remove(url) {
  const norm = normalizeUrl(url);
  const list = load();
  const before = list.length;
  entries = list.filter((e) => e.url !== norm);
  scheduleFlush();
  return before !== entries.length;
}

function clear() {
  entries = [];
  scheduleFlush();
}

function topHosts(limit = 8) {
  const list = load();
  const counts = new Map();
  for (const e of list) {
    let host;
    try {
      const u = new URL(e.url);
      host = u.hostname.replace(/^www\./, '');
    } catch (err) { continue; }
    if (!host) continue;
    const rec = counts.get(host) || { host, count: 0, url: e.url, title: e.title, ts: e.ts };
    rec.count += 1;
    if (e.ts > rec.ts) { rec.ts = e.ts; rec.url = e.url; rec.title = e.title; }
    counts.set(host, rec);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

module.exports = { add, recent, all, remove, clear, topHosts, flush, normalizeUrl };