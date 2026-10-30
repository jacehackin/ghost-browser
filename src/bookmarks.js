// src/bookmarks.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = path.join(app.getPath('userData'), 'bookmarks.json');

let items = null;
let flushTimer = null;

function load() {
  if (items) return items;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    items = [];
  }
  return items;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 400);
}

function flush() {
  flushTimer = null;
  if (!items) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(items, null, 2), 'utf8');
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

function list() {
  return load().slice();
}

function has(url) {
  const n = normalizeUrl(url);
  return load().some((b) => b.url === n);
}

function add({ url, title }) {
  const n = normalizeUrl(url);
  if (!n) return null;
  const arr = load();
  const existing = arr.find((b) => b.url === n);
  if (existing) {
    if (title) existing.title = String(title).slice(0, 256);
    scheduleFlush();
    return existing;
  }
  const entry = { url: n, title: String(title || n).slice(0, 256), ts: Date.now() };
  arr.unshift(entry);
  scheduleFlush();
  return entry;
}

function remove(url) {
  const n = normalizeUrl(url);
  const arr = load();
  const before = arr.length;
  items = arr.filter((b) => b.url !== n);
  scheduleFlush();
  return before !== items.length;
}

function toggle({ url, title }) {
  if (has(url)) {
    remove(url);
    return { added: false };
  }
  add({ url, title });
  return { added: true };
}

function clear() {
  items = [];
  scheduleFlush();
}

module.exports = {
  list, has, add, remove, toggle, clear, flush, normalizeUrl
};