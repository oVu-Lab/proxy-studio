# Global Zero-Quota Deployment Guide (Cloudflare Pages)

Deploy **Proxy Studio** publicly for anyone in the world to use — completely **free**, with **unlimited visitors**, **zero shared database**, and **0 / 100,000 Cloudflare Workers daily quota burned** on user `/v1/chat/completions` traffic.

---

## How the Zero-Quota Architecture Works

| Layer | Where it runs | Quota used on YOUR account | Privacy |
|---|---|---|---|
| **Proxy Studio Web UI** | Cloudflare Pages (pure static HTML/JS/CSS) | **Unlimited free requests** | Zero server logging |
| **Adapters, Headers, Keys, Logs & Playground History** | Each visitor's own browser `localStorage` | **0 requests** | 100% isolated per user — visitors never see each other's sites or tokens |
| **Live Browser Capture & Payload Analyzer** | Inside the visitor's own browser (runs `capture-script` + `copy(__proxyCapture.last)` + Manual Paste) | **0 requests** | Private — captured cookies/tokens never hit your host |
| **User `/v1/chat/completions` Traffic** | Exported to **each user's own** Cloudflare Worker (`worker.js`, their own 100k/day free tier) **or** their own computer (`proxy.mjs`, unlimited local) | **0 requests on your account** | Full ownership by each user |

Compare with running **locally** via `npm start`:
- **Local Mode (`npm start` → `http://localhost:8088`)**: runs a live Node.js server storing everything in `./data/db.json`, auto-discovers public chat bundles, runs auto-callback Live Browser Capture (`POST /api/capture/ingest` with CORS + `Access-Control-Allow-Private-Network: true`), live-probes endpoints, serves `/v1/chat/completions` and `/proxy/:id/v1/*`, **and** lets you export `worker.js` or `proxy.mjs`.
- **Global Mode (`npm run build:pages` → `./out`)**: pure static site for Cloudflare Pages. Automatically opens in **Global Zero-Quota Mode** with browser-isolated `localStorage`, built-in Capture & Manual Paste analyzer, bundled verified **RusherAI** template, and the 1-click **Export Personal `/v1` Gateway** studio.

---

## Option A — Deploy via Cloudflare Dashboard (Git Auto-Deploy, 2 minutes)

1. Push this repository to GitHub or GitLab.
2. Open [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
3. Pick your repository and enter these build settings:
   - **Framework preset**: `None`
   - **Build command**: `npm run build:pages`
   - **Build output directory**: `out`
   - **Node version** (Environment variable): `NODE_VERSION` = `20`
4. Click **Save and Deploy**. Every future push auto-deploys for free with unlimited static traffic!

---

## Option B — Deploy via CLI (`wrangler`, 30 seconds)

```bash
npm install
npm run build:pages
npx wrangler pages deploy out --project-name=proxy-studio
```

Cloudflare prints your live public HTTPS URL (e.g. `https://proxy-studio.pages.dev`). You can attach any custom domain inside Cloudflare Pages → **Custom domains**.

> Note: Running `npm run build:pages` temporarily excludes local server API routes while generating `./out`, then automatically restores every source file so `npm run build && npm start` stays ready for local usage.

---

## How Each Visitor Gets Their Own Free `/v1` Endpoint

1. Open your deployed Proxy Studio URL — `RusherAI` is already pre-loaded in their browser.
2. Add any other AI chat site via **Start capture** (DevTools Console snippet / draggable Bookmarklet / `copy(__proxyCapture.last)` manual paste) or **Paste cURL / JSON**. Everything saves privately in their own browser's `localStorage`.
3. Open **Export Gateway** and choose one:
   - **Cloudflare Worker (100k/day free each)**: Click **Copy Worker Code** or download `worker.js` + `wrangler.toml`. Paste in their own free Cloudflare Dashboard (**Workers → Create Worker → Edit code → Deploy**) or run `npx wrangler deploy`. Set an optional secret key via `npx wrangler secret put API_KEY`. Their personal Base URL is `https://<their-worker>.workers.dev/v1`.
   - **Local Mac / Windows Companion (unlimited, zero cloud)**: Click **Download `proxy.mjs`** + `start-mac.command` (macOS) or `start-windows.bat` (Windows). Put both in one folder and double-click (requires Node.js 18+, zero `npm install`). Their local Base URL is `http://127.0.0.1:8088/v1` — paste right into Magpie, Cherry Studio, Cursor, or any OpenAI SDK.
4. *(Optional)* Paste their personal deployed URL into **Export Gateway → Connect Playground** to chat with it right inside Proxy Studio.

---

## Security Notes for Hosted Users

- All exported `worker.js` and `proxy.mjs` files keep captured auth headers/cookies **off** by default — users explicitly opt in before exporting and should treat downloaded files containing tokens as private.
- Encourage visitors deploying a public `workers.dev` URL to add an `API_KEY` secret so strangers can't use their personal endpoint.
- `./out/_headers` automatically ships baseline headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`).
