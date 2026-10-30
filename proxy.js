// proxy.js
// Minimal HTTP/HTTPS forward proxy that strips CORS headers and answers preflights.
const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');

let server = null;
let port = 8899;

const STRIP = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-allow-credentials',
  'access-control-expose-headers',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security'
]);

function rewriteHeaders(headers, origin) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (STRIP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  out['Access-Control-Allow-Origin'] = origin || '*';
  out['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD';
  out['Access-Control-Allow-Headers'] = '*';
  out['Access-Control-Expose-Headers'] = '*';
  out['Access-Control-Max-Age'] = '86400';
  if (origin && origin !== '*') {
    out['Access-Control-Allow-Credentials'] = 'true';
  }
  return out;
}

function handleRequest(clientReq, clientRes) {
  const origin = clientReq.headers['origin'] || '*';

  // Preflight — answer immediately, no upstream hit needed
  if (clientReq.method === 'OPTIONS') {
    clientRes.writeHead(204, rewriteHeaders({}, origin));
    clientRes.end();
    return;
  }

  let targetUrl = clientReq.url;
  if (!/^https?:\/\//i.test(targetUrl)) {
    // Fallback when used as an HTTP proxy via chrome flags
    const hostHeader = clientReq.headers['host'] || '';
    targetUrl = `http://${hostHeader}${targetUrl}`;
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (e) {
    clientRes.writeHead(400, { 'Content-Type': 'text/plain' });
    clientRes.end('bad url');
    return;
  }

  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;

  const forwardHeaders = Object.assign({}, clientReq.headers);
  forwardHeaders['host'] = parsed.host;
  forwardHeaders['accept-encoding'] = 'identity';
  delete forwardHeaders['origin'];
  delete forwardHeaders['referer'];

  const upstreamReq = transport.request({
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: clientReq.method,
    headers: forwardHeaders,
    rejectUnauthorized: false
  }, (upstreamRes) => {
    const rewritten = rewriteHeaders(upstreamRes.headers, origin);
    clientRes.writeHead(upstreamRes.statusCode || 502, rewritten);
    upstreamRes.pipe(clientRes);
  });

  upstreamReq.on('error', (err) => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*'
      });
    }
    clientRes.end(`proxy error: ${err.message}`);
  });

  clientReq.pipe(upstreamReq);
}

function startProxy(preferredPort) {
  port = preferredPort || port;

  // CONNECT tunneling for https through plain proxy semantics
  server = http.createServer(handleRequest);

  server.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = req.url.split(':');
    const targetPort = parseInt(portStr, 10) || 443;

    const { connect } = require('net');
    const upstreamSocket = connect(targetPort, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });

    upstreamSocket.on('error', () => clientSocket.end());
    clientSocket.on('error', () => upstreamSocket.end());
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[proxy] listening on http://127.0.0.1:${port}`);
  });

  server.on('error', (err) => {
    console.error(`[proxy] failed to start: ${err.message}`);
  });
}

function stopProxy() {
  if (server) {
    try { server.close(); } catch (e) {}
    server = null;
  }
}

function getProxyUrl() {
  return `http://127.0.0.1:${port}`;
}

module.exports = { startProxy, stopProxy, getProxyUrl };