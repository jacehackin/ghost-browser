// src/bypass.js
'use strict';

const { session } = require('electron');

const HEADERS_TO_STRIP = [
  'content-security-policy',
  'content-security-policy-report-only',
  'x-content-security-policy',
  'x-webkit-csp',
  'x-frame-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
  'feature-policy',
  'permissions-policy'
];

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const state = { enabled: true };

function setEnabled(v) { state.enabled = !!v; }
function isEnabled() { return state.enabled; }

function rewriteResponseHeaders(headers) {
  const out = {};
  const strip = new Set(HEADERS_TO_STRIP);
  for (const [k, v] of Object.entries(headers || {})) {
    if (strip.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  out['Access-Control-Allow-Origin'] = ['*'];
  out['Access-Control-Allow-Methods'] = ['GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD'];
  out['Access-Control-Allow-Headers'] = ['*'];
  out['Access-Control-Expose-Headers'] = ['*'];
  out['Access-Control-Max-Age'] = ['86400'];
  return out;
}

function configureSession() {
  const ses = session.defaultSession;

  // strip CSP / XFO / COOP / COEP → inject permissive CORS on every response
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (!state.enabled) return callback({ responseHeaders: details.responseHeaders });
    callback({ responseHeaders: rewriteResponseHeaders(details.responseHeaders) });
  });

  // ensure a real user-agent when one is missing
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = Object.assign({}, details.requestHeaders);
    const hasUA = Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent');
    if (!hasUA) headers['User-Agent'] = DEFAULT_UA;
    callback({ requestHeaders: headers });
  });

  // auto-grant everything
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  ses.setPermissionCheckHandler(() => true);

  // ignore every TLS error
  ses.setCertificateVerifyProc((_request, callback) => callback(0));

  // preflight short-circuit: nothing to do, but keep an explicit handler
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (_details, callback) => {
    callback({ cancel: false });
  });
}

module.exports = { configureSession, setEnabled, isEnabled, rewriteResponseHeaders };