// src/log-store.js
'use strict';

const MAX_ENTRIES = 2000;
const listeners = new Set();
const ring = [];
let seq = 0;

function push(entry) {
  seq += 1;
  const record = {
    id: seq,
    ts: Date.now(),
    method: entry.method || 'GET',
    url: entry.url || '',
    status: entry.status || 0,
    origin: entry.origin || '',
    bytes: entry.bytes || 0,
    blocked: !!entry.blocked,
    viaProxy: !!entry.viaProxy,
    tabId: entry.tabId || null,
    reqHeaders: entry.reqHeaders || null,
    resHeaders: entry.resHeaders || null
  };

  ring.push(record);
  if (ring.length > MAX_ENTRIES) ring.shift();

  for (const fn of listeners) {
    try { fn(record); } catch (e) {}
  }
  return record;
}

function all() {
  return ring.slice();
}

function clear() {
  ring.length = 0;
  for (const fn of listeners) {
    try { fn({ id: 0, ts: Date.now(), __clear: true }); } catch (e) {}
  }
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function stats() {
  let total = 0, blocked = 0, errors = 0;
  for (const r of ring) {
    total += 1;
    if (r.blocked) blocked += 1;
    if (r.status >= 400) errors += 1;
  }
  return { total, blocked, errors, size: ring.length, max: MAX_ENTRIES };
}

module.exports = { push, all, clear, subscribe, stats };