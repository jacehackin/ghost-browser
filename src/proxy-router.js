// src/proxy-router.js
// Bridges tab-state → Electron session proxy resolution.
'use strict';

const tabState = require('./tab-state');

const DIRECT = 'direct://';
const SYSTEM = 'system://';

function toElectronProxy(value) {
  if (!value || value === 'direct') return { proxyRules: DIRECT };
  if (value === 'system') return { proxyRules: SYSTEM };
  // explicit url like http://127.0.0.1:8899
  if (/^https?:\/\//i.test(value)) {
    // strip scheme for electron proxyRules
    const stripped = value.replace(/^https?:\/\//i, '');
    return { proxyRules: 'PROXY ' + stripped };
  }
  return { proxyRules: DIRECT };
}

function install({ session }) {
  const ses = session.defaultSession;

  // Global default always resolves through tab-state's global value.
  ses.setProxy(toElectronProxy(tabState.getGlobalProxy())).catch(() => {});

  // Per-request the browser stack calls resolveProxy; we route by webContents id
  // when the origin is known, else fall through to the global rule.
  ses.setProxy
    ? null
    : null;

  // Chromium doesn't hand per-request webContents to setProxy, so we use a
  // partitioned session per proxy mode instead. That's the reliable route.
  // buildSessionForProxy() returns the right session object for a tab.
}

// Creates (and caches) a session whose proxy matches `proxyValue`.
const cache = new Map();

function buildSessionForProxy(proxyValue, baseSession, partitions) {
  const key = proxyValue || 'direct';
  if (cache.has(key)) return cache.get(key);

  const partitionName = 'persist:ghost-' + key.replace(/[^a-z0-9]/gi, '_');
  const ses = baseSession.fromPartition
    ? baseSession.fromPartition(partitionName)
    : baseSession.defaultSession;

  const rules = toElectronProxy(proxyValue);
  ses.setProxy(rules).catch(() => {});

  cache.set(key, ses);
  return ses;
}

function invalidate(proxyValue) {
  if (proxyValue) cache.delete(proxyValue);
  else cache.clear();
}

module.exports = { install, buildSessionForProxy, toElectronProxy, invalidate };