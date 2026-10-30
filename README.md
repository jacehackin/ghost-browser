# Ghost — CORS-Free Browser

Multi-layer bypass browser. Built on Electron. Every layer of same-origin policy removed.

## Layers of bypass

1. **Chromium flags** — `disable-web-security`, `OutOfBlinkCors` feature kill, site isolation off.
2. **Session header rewriting** — every response from every URL gets:
   - CSP / CSP-report-only / X-WebKit-CSP deleted
   - X-Frame-Options deleted
   - COOP / COEP / CORP deleted
   - HSTS deleted
   - Permissive `Access-Control-Allow-*` injected
3. **Local forward proxy** (`127.0.0.1:8899`) — answers preflights with 204 + permissive headers, tunnels HTTPS via CONNECT, strips CORS blockers on the way back.

## Install

```bash
npm install
npm start