# Proxy Studio

A local-first studio for connecting supported AI chat websites to OpenAI-compatible clients. Adapters, settings, and the last 200 request-metadata entries are saved in `./data/db.json`. There is no database service, container, account, or migration to set up.

## Start

Requires **Node.js 20.9 or later** and npm.

```bash
npm install
npm start
```

Open **http://localhost:8088**. The first `npm start` automatically builds the app; subsequent starts use that build. To rebuild after changing source, run `npm run build`.

On macOS, double-click `start-mac.command`. It installs dependencies on first launch, starts the app, and opens the browser. You may need to allow the file under macOS Privacy & Security the first time. Keep the terminal window open while using the studio.

The server binds to `127.0.0.1` by default. Change the port with `PORT=9000 npm start`. You can explicitly set `HOST=0.0.0.0`, but doing so exposes the **unauthenticated management interface** to your network; do not expose it to untrusted users. The optional gateway key does not protect the management interface.

## Connect a site

1. Paste a website URL into **Auto-discover**. The server reads the HTML and linked public JS/CSS files with bounded HTTP GET requests. It heuristically searches for likely endpoints, models, and request fields.
2. It sends a short live chat request to a small number of candidate endpoints using an Origin and Referer derived from the website URL. A verified adapter is saved only when a recognizable JSON or streaming response is received. This test can consume the site's resources or quota.
3. If static discovery cannot find or verify an endpoint (e.g. auth-gated, Cloudflare-protected, or obfuscated/dynamic sites), Proxy Studio **automatically starts a Live Browser Capture session** (`GET /api/capture/session/:id`, polled every 2 seconds) and provides both:
   - a **one-click copyable DevTools Console snippet**, and
   - a **draggable Bookmarklet** (`javascript:...`) for your browser's bookmarks bar.
   
   Running either on the target site attaches non-destructive hooks on `fetch`, `XMLHttpRequest`, `EventSource`, **and `WebSocket`**, auto-hooks accessible same-origin `<iframe>`s, prints a bright yellow warning if cross-origin `<iframe>`s exist (guiding you to switch the DevTools Console `top` dropdown), supports `application/json`, `text/plain` JSON strings, `FormData`, `URLSearchParams`, `GET` query params, and WS frames, filters static assets and analytics/Firestore telemetry without over-filtering unusual APIs, and automatically POSTs captures to `http://localhost:8088/api/capture/ingest?sessionId=...` (with `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Private-Network: true`). If a site's Content-Security-Policy (CSP) or mixed-content rules block auto-send, the script saves captures into `window.__proxyCapture.last` (and `.all`) and prints an instant fix (`copy(__proxyCapture.last)`) to paste straight into the **Manual Paste Fallback** box inside the Capture Modal. All errors are translated into plain-English guidance with exact next actions.
4. For sites using `HttpOnly` login cookies (401/403), paste DevTools **Copy as cURL** or **Copy as fetch** into either the **Manual Paste Fallback** tab inside the Capture Modal or the main **Paste cURL / JSON** tab. All pasted text is parsed — never executed.

## Global Zero-Quota Hosting (Cloudflare Pages)

Deploy Proxy Studio publicly with **zero shared database** and **0 host Workers quota consumed** — see [`DEPLOY_GLOBAL.md`](./DEPLOY_GLOBAL.md):

```bash
npm run build:pages
npx wrangler pages deploy out --project-name=proxy-studio
```

In Global Mode, each visitor's adapters, headers, logs, and Playground history stay privately inside their own browser's `localStorage`. Every user gets 1-click **Export Gateway** options:
- **Personal Cloudflare Worker** (`worker.js` + `wrangler.toml`) — runs on *their own* free 100,000 req/day quota.
- **Zero-dependency Local Companion** (`proxy.mjs` + `start-mac.command` + `start-windows.bat`) — zero `npm install`, listens on `http://127.0.0.1:8088/v1` for Magpie, Cherry Studio, and OpenAI SDKs.

Discovery is heuristic, not guaranteed to work with every site. It cannot obtain login sessions, solve challenges, execute obfuscated code, or predict changing tokens. The importer supports JSON requests containing a `messages` array; unsupported request shapes, tool calls, images, and dynamic JavaScript variables are not silently converted. Imported session credentials may expire and must be updated by the user.

The bundled **RusherAI** adapter is preconfigured for `https://allaitools-generate.freemodels.workers.dev/api/chat` with `Origin: https://rusherai.com`. The endpoint and model list may change or stop working. Model names are upstream labels and do not guarantee the identity of the actual provider/model.

## OpenAI-compatible gateway

Use **http://localhost:8088/v1** as the base URL in Magpie, Cherry Studio, or an OpenAI-compatible SDK. If no local API key is configured, use any placeholder when a client requires one.

- `GET /v1/models` lists models from enabled adapters using `adapter-id/model-id` names.
- `POST /v1/chat/completions` accepts text-only chat messages and supports JSON or SSE (`stream: true`).
- `GET /proxy/:adapterId/v1/models` and `POST /proxy/:adapterId/v1/chat/completions` isolate one adapter; its model IDs are unprefixed.
- Where the upstream has corresponding flags, append `-think`, `-search`, or `-think-search` to the model ID. These variants are listed by `/v1/models`.
- CORS is enabled on gateway endpoints. There is no automatic forwarding of arbitrary OpenAI options; the imported upstream request template controls what the site supports.

Example:

```bash
curl http://localhost:8088/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"rusherai/gpt-6-astra","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

In Python:

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8088/v1", api_key="not-needed")
reply = client.chat.completions.create(
    model="rusherai/gpt-6-astra",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(reply.choices[0].message.content)
```

Configure an optional gateway key under **Settings**, or set `STUDIO_API_KEY` in the server environment. When enabled, send `Authorization: Bearer YOUR_KEY` (or `X-API-Key`). The environment variable takes precedence over the saved key.

## Security and data

- Imported headers, cookies, request templates, and any key saved in Settings are stored **unencrypted** in `data/db.json`. Protect that file and do not share it. Header values are not returned by the dashboard API. Prompts and responses are not stored in the activity log.
- The management UI has no login. Bind only to loopback unless you provide your own protection. Gateway CORS permits browser clients; set a gateway key if you do not trust other websites on your machine.
- Private, loopback, and link-local discovery targets are blocked by default to reduce SSRF risk. For trusted local test servers only, start with `STUDIO_ALLOW_PRIVATE_TARGETS=1 npm start`. URL/DNS checks are not a substitute for network isolation.
- The studio does not bypass upstream authentication, quotas, or terms. Only connect sites and credentials you are authorized to use.
- If the JSON file is deleted, it is recreated with the bundled adapter on the next request. Back it up before making changes. Do not edit it while the server is running.
