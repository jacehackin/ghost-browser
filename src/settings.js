// src/settings.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
  fullscreen: true,
  searchEngine: 'duckduckgo',
  bypass: true,
  homepage: 'ghost://newtab',
  lastClosedTabs: []
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    cache = Object.assign({}, DEFAULTS, JSON.parse(raw));
  } catch (e) {
    cache = Object.assign({}, DEFAULTS);
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) { /* non-fatal */ }
}

function get(key) { return load()[key]; }

function set(key, value) {
  load()[key] = value;
  save();
  return value;
}

function all() { return Object.assign({}, load()); }

module.exports = { get, set, all, save };