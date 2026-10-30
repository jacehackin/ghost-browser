// src/rules-engine.js
'use strict';

// Rule shape:
// {
//   id: string,
//   enabled: boolean,
//   match: string,          // regex against URL, or "*" for all
//   phase: "request" | "response" | "both",
//   set: { "Header-Name": "value" },
//   remove: [ "Header-Name" ]
// }

const DEFAULTS = [
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
    id: 'permisive-cors',
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

let rules = DEFAULTS.map((r) => Object.assign({}, r));
let compiled = new Map();

function recompile() {
  compiled.clear();
  for (const r of rules) {
    let re = null;
    try {
      re = new RegExp(r.match === '*' ? '.*' : r.match);
    } catch (e) {
      re = /$^/; // never matches
    }
    compiled.set(r.id, re);
  }
}

function matches(id, url) {
  const re = compiled.get(id);
  if (!re) return false;
  return re.test(url);
}

function applyRequest(url, headers) {
  const out = Object.assign({}, headers);
  const applied = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.phase !== 'request' && r.phase !== 'both') continue;
    if (!matches(r.id, url)) continue;

    if (r.remove) {
      const kill = new Set(r.remove.map((h) => h.toLowerCase()));
      for (const k of Object.keys(out)) {
        if (kill.has(k.toLowerCase())) delete out[k];
      }
    }
    if (r.set) {
      for (const [k, v] of Object.entries(r.set)) out[k] = v;
    }
    applied.push(r.id);
  }
  return { headers: out, applied };
}

function applyResponse(url, headers) {
  const out = Object.assign({}, headers);
  const applied = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.phase !== 'response' && r.phase !== 'both') continue;
    if (!matches(r.id, url)) continue;

    if (r.remove) {
      const kill = new Set(r.remove.map((h) => h.toLowerCase()));
      for (const k of Object.keys(out)) {
        if (kill.has(k.toLowerCase())) delete out[k];
      }
    }
    if (r.set) {
      for (const [k, v] of Object.entries(r.set)) out[k] = v;
    }
    applied.push(r.id);
  }
  return { headers: out, applied };
}

function list() {
  return rules.map((r) => Object.assign({}, r));
}

function add(rule) {
  if (!rule.id) rule.id = 'rule-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
  rule.enabled = rule.enabled !== false;
  rule.phase = rule.phase || 'both';
  rule.set = rule.set || {};
  rule.remove = rule.remove || [];
  rule.match = rule.match || '.*';
  rules.push(rule);
  recompile();
  return rule;
}

function update(id, patch) {
  const idx = rules.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  rules[idx] = Object.assign({}, rules[idx], patch);
  recompile();
  return rules[idx];
}

function remove(id) {
  const before = rules.length;
  rules = rules.filter((r) => r.id !== id);
  recompile();
  return rules.length !== before;
}

function setEnabled(id, enabled) {
  return update(id, { enabled: !!enabled });
}

function reset() {
  rules = DEFAULTS.map((r) => Object.assign({}, r));
  recompile();
  return rules;
}

recompile();

module.exports = {
  applyRequest,
  applyResponse,
  list,
  add,
  update,
  remove,
  setEnabled,
  reset
};