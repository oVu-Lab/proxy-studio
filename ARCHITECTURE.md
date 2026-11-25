# Proxy Studio — Technical Architecture & Specification

This document describes the internal architecture, dual-mode build pipeline, discovery engine, and security boundaries of **Proxy Studio** for developers and self-hosters.

---

## 1. Dual-Mode Runtime Architecture

Proxy Studio compiles from a single codebase into two distinct runtime targets:

| Dimension | Local Mode (`npm start`) | Global Static Mode (`npm run build:pages`) |
| :--- | :--- | :--- |
| **Runtime** | Node.js server (`127.0.0.1:8088`) | Pure static SPA (`./out`, Cloudflare Pages) |
| **Persistence** | Local JSON file (`./data/db.json`) | Per-user browser `localStorage` |
| **Discovery** | Server-side static scan + live probe + callback ingest | Client-side Live Capture + Manual Paste / cURL parser |
| **`/v1` Gateway** | Served directly on `localhost:8088/v1` | Offloaded via 1-click export (`worker.js` or `proxy.mjs`) |
| **Host Quota** | N/A (local) | **0 Workers requests** (unlimited static hosting) |

### Static Export Build Pipeline
Running `npm run build:pages` temporarily excludes Node.js-only server API routes while generating the static `./out` bundle, then restores all source files automatically so `npm run build && npm start` remains intact for local development.

---

## 2. 3-Tier Site Discovery & Capture Engine

1. **Tier 1 — Static Bundle Scanner (Local Mode)**
   - Fetches target HTML and linked public JS/CSS bundles via bounded HTTP GET requests.
   - Heuristically extracts candidate inference endpoints, model arrays, payload schemas, and `Origin`/`Referer` requirements, followed by a live connectivity probe.
2. **Tier 2 — Live Browser Capture**
   - Injects a non-destructive interceptor (Console snippet or Bookmarklet) hooking `fetch`, `XMLHttpRequest`, `EventSource`, and `WebSocket`.
   - Auto-hooks same-origin `<iframe>`s and warns on cross-origin `<iframe>`s.
   - **Auto-Callback**: POSTs captured metadata to `POST /api/capture/ingest` with `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Private-Network: true`.
   - **CSP Fallback**: If target site CSP blocks `fetch`, captures are buffered in `window.__proxyCapture.last` for manual clipboard export (`copy(__proxyCapture.last)`).
3. **Tier 3 — Static cURL / fetch Parser**
   - Parses DevTools **Copy as cURL** / **Copy as fetch** text without execution to support `HttpOnly` cookie-gated endpoints (`401`/`403`).

---

## 3. OpenAI-Compatible Gateway & Export Targets

- **Unified Endpoints**: `GET /v1/models`, `POST /v1/chat/completions`, and per-adapter isolated routes `/proxy/:adapterId/v1/*`.
- **Suffix Routing**: Model IDs ending in `-think`, `-search`, or `-think-search` dynamically toggle upstream reasoning/search flags when supported by the adapter template.
- **Exported Gateways (Zero Host Quota)**:
  - **Personal Cloudflare Worker**: Zero-dependency `worker.js` + `wrangler.toml` running on the user's own 100k/day free tier (`npx wrangler secret put API_KEY` supported).
  - **Local Companion**: Zero-dependency `proxy.mjs` + `start-mac.command` / `start-windows.bat` (Node.js 18+, no `npm install`).

---

## 4. Security & Isolation Boundaries

- **Credential Opt-In**: Exported `worker.js` and `proxy.mjs` files strip captured auth headers and cookies by default; users must explicitly opt in before exporting.
- **Data Isolation**: In Global Mode, adapters, headers, and Playground history never leave the visitor's browser. In Local Mode, `data/db.json` stores credentials unencrypted and should never be committed or shared.
- **SSRF Mitigation**: Private, loopback, and link-local discovery targets are blocked by default (override only for trusted local testing via `STUDIO_ALLOW_PRIVATE_TARGETS=1`).
- **Static Security Headers**: `./out/_headers` ships `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and `Referrer-Policy: strict-origin-when-cross-origin`.
