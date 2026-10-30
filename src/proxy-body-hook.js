// src/proxy-body-hook.js
// Attach to proxy.js: lets the proxy hand bodies to the rewriter before
// they hit the renderer. Include this logic inside proxy.js's response pipe.
'use strict';

// ── snippet to paste into proxy.js ──
//
// Replace this block inside handleRequest():
//
//   upstreamRes.pipe(clientRes);
//
// WITH:
//
//   const ctKey = Object.keys(upstreamRes.headers)
//     .find(k => k.toLowerCase() === 'content-type') || '';
//   const encKey = Object.keys(upstreamRes.headers)
//     .find(k => k.toLowerCase() === 'content-encoding') || '';
//   const contentType = ctKey ? String(upstreamRes.headers[ctKey]) : '';
//   const encoding = encKey ? String(upstreamRes.headers[encKey]) : 'identity';
//
//   const editable = /json|text|javascript|xml|html/i.test(contentType);
//
//   if (!editable || !bodyTransform) {
//     upstreamRes.pipe(clientRes);
//   } else {
//     collectBody(upstreamRes).then(async (raw) => {
//       const result = await bodyTransform({ url: targetUrl, contentType, encoding, buffer: raw });
//       const finalBuf = result.buffer || raw;
//
//       // fix content-length after transform
//       const outHdrs = Object.assign({}, rewritten);
//       Object.keys(outHdrs).forEach(k => {
//         if (k.toLowerCase() === 'content-length') delete outHdrs[k];
//       });
//       outHdrs['Content-Length'] = String(finalBuf.length);
//
//       clientRes.writeHead(upstreamRes.statusCode || 502, outHdrs);
//       clientRes.end(finalBuf);
//     }).catch(() => {
//       // fall back to raw pass-through on error
//       upstreamRes.pipe(clientRes);
//     });
//   }
//
// And add at the top of proxy.js:
//
//   let bodyTransform = null;
//   function setBodyTransform(fn) { bodyTransform = fn; }
//   function collectBody(stream) {
//     return new Promise((resolve, reject) => {
//       const chunks = [];
//       stream.on('data', c => chunks.push(c));
//       stream.on('end', () => resolve(Buffer.concat(chunks)));
//       stream.on('error', reject);
//     });
//   }
//
// And in module.exports:
//
//   module.exports = { startProxy, stopProxy, getProxyUrl, setBodyTransform };

module.exports = {};