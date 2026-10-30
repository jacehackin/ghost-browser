// src/tab-state.js
// Tracks per-tab proxy preference so the request handler can reroute.
'use strict';

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', '.chrome-profile', 'tab-state.json');

let state = {
  // tabId (webContents.id) -> { proxy: "direct" | "system" | "http://..." , origin: string, title: string }
  tabs: {},
  global: { proxy: 'direct' }
};

function load() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state = Object.assign({ tabs: {}, global: { proxy: 'direct' } }, parsed);
  } catch (e) { /* first boot */ }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) { /* non-fatal */ }
}

function registerTab(id, meta) {
  state.tabs[id] = Object.assign({ proxy: 'inherit' }, state.tabs[id], meta || {});
  save();
  return state.tabs[id];
}

function unregisterTab(id) {
  delete state.tabs[id];
  save();
}

function setTabProxy(id, proxy) {
  if (!state.tabs[id]) state.tabs[id] = { proxy: 'inherit' };
  state.tabs[id].proxy = proxy || 'inherit';
  save();
  return state.tabs[id];
}

function getTabProxy(id) {
  const t = state.tabs[id];
  if (t && t.proxy && t.proxy !== 'inherit') return t.proxy;
  return state.global.proxy || 'direct';
}

function setGlobalProxy(proxy) {
  state.global.proxy = proxy || 'direct';
  save();
  return state.global;
}

function getGlobalProxy() {
  return state.global.proxy || 'direct';
}

function all() {
  return { tabs: Object.assign({}, state.tabs), global: Object.assign({}, state.global) };
}

load();

module.exports = {
  registerTab,
  unregisterTab,
  setTabProxy,
  getTabProxy,
  setGlobalProxy,
  getGlobalProxy,
  all,
  save
};