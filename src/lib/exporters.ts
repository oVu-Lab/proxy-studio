import type { Adapter } from "@/lib/types";

export type ExportOptions = {
  /** Include captured auth headers/cookies in the exported code (kept strictly local to the downloaded file). */
  includeCredentials?: boolean;
  /** Optional API key checked as Authorization: Bearer <key> or X-API-Key. Empty means no auth required. */
  apiKey?: string;
  /** Default listening port for proxy.mjs (default 8088). */
  port?: number;
  /** Cloudflare Worker name for wrangler.toml. */
  workerName?: string;
};

type BakedAdapter = {
  id: string;
  name: string;
  endpoint: string;
  method: "POST" | "GET" | "WS";
  origin: string;
  referer: string;
  headers: Record<string, string>;
  requestTemplate: Record<string, unknown>;
  schema: Adapter["schema"];
  models: { id: string; name: string }[];
  createdAt: string;
};

const CRED_HEADER_RE = /^(authorization|cookie|set-cookie|x-api-key|api-key|x-auth.*|x-session.*|x-token.*)$/i;
const SKIP_HEADER_RE = /^(host|content-length|connection|transfer-encoding|accept-encoding|origin|referer|sec-.*|:.*)$/i;

function bakeAdapters(adapters: Adapter[], includeCredentials: boolean): BakedAdapter[] {
  return adapters
    .filter((a) => a.enabled)
    .map((a) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(a.headers || {})) {
        if (SKIP_HEADER_RE.test(k)) continue;
        if (!includeCredentials && CRED_HEADER_RE.test(k)) continue;
        headers[k] = v;
      }
      return {
        id: a.id,
        name: a.name,
        endpoint: a.endpoint,
        method: a.method || (/^wss?:/i.test(a.endpoint) ? "WS" : "POST"),
        origin: a.origin,
        referer: a.referer,
        headers,
        requestTemplate: a.requestTemplate || {},
        schema: a.schema,
        models: a.models.map((m) => ({ id: m.id, name: m.name })),
        createdAt: a.createdAt || new Date().toISOString(),
      };
    });
}

/** Shared zero-dependency runtime engine baked cleanly into both Cloudflare Worker & local Node.js proxy. */
function buildSharedEngine(baked: BakedAdapter[], embeddedKey: string): string {
  const adaptersJson = JSON.stringify(baked, null, 2);
  const keyLiteral = JSON.stringify(embeddedKey || "");

  return `const ADAPTERS = ${adaptersJson};
const DEFAULT_API_KEY = ${keyLiteral};
const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key",
  "Access-Control-Allow-Private-Network": "true",
};

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function errRes(message, status, code, type = "invalid_request_error") {
  return jsonRes({ error: { message, type, param: null, code } }, status);
}

function checkAuth(request, expectedKey) {
  if (!expectedKey) return true;
  const auth = request.headers.get("authorization") || "";
  const supplied = auth.replace(/^Bearer\\s+/i, "") || request.headers.get("x-api-key") || "";
  if (supplied.length !== expectedKey.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) diff |= supplied.charCodeAt(i) ^ expectedKey.charCodeAt(i);
  return diff === 0;
}

function setPath(target, path, value) {
  if (!path || !path.length) return;
  let obj = target;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (BLOCKED_KEYS.has(k)) return;
    if (!obj[k] || typeof obj[k] !== "object" || Array.isArray(obj[k])) obj[k] = {};
    obj = obj[k];
  }
  const leaf = path[path.length - 1];
  if (!BLOCKED_KEYS.has(leaf)) obj[leaf] = value;
}

function getPath(target, path) {
  let cur = target;
  for (const k of path || []) {
    if (!cur || typeof cur !== "object" || BLOCKED_KEYS.has(k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function formatPrompt(messages) {
  if (messages.length === 1 && messages[0].role === "user") return messages[0].content;
  const nonEmpty = messages.filter((m) => m.content.trim());
  if (nonEmpty.length === 1) return nonEmpty[0].content;
  return nonEmpty.map((m) =>
    m.role === "system" ? "System: " + m.content : m.role === "assistant" ? "Assistant: " + m.content : "User: " + m.content
  ).join("\\n\\n");
}

function buildModelsList(adapterId) {
  const list = adapterId ? ADAPTERS.filter((a) => a.id === adapterId) : ADAPTERS;
  if (adapterId && !list.length) return null;
  const data = [];
  for (const a of list) {
    const created = Math.floor((Date.parse(a.createdAt) || Date.now()) / 1000);
    for (const m of a.models) {
      const base = adapterId ? m.id : a.id + "/" + m.id;
      const variants = [base];
      if (a.schema.thinking) variants.push(base + "-think");
      if (a.schema.deepSearch) variants.push(base + "-search");
      if (a.schema.thinking && a.schema.deepSearch) variants.push(base + "-think-search");
      for (const id of variants) data.push({ id, object: "model", created, owned_by: a.id });
    }
  }
  return { object: "list", data };
}

function resolveModel(raw, scoped) {
  let model = raw, thinking = false, search = false;
  for (let i = 0; i < 2; i++) {
    if (model.endsWith("-think") && !thinking) { thinking = true; model = model.slice(0, -6); }
    else if (model.endsWith("-search") && !search) { search = true; model = model.slice(0, -7); }
    else break;
  }
  let list = scoped ? ADAPTERS.filter((a) => a.id === scoped) : ADAPTERS.slice();
  if (!scoped) {
    const ns = model.split("/")[0];
    const hit = list.find((a) => a.id === ns);
    if (hit) { list = [hit]; model = model.slice(ns.length + 1); }
  } else if (model.startsWith(scoped + "/")) {
    model = model.slice(scoped.length + 1);
  }
  const matches = list.filter((a) => a.models.some((m) => m.id === model));
  if (matches.length !== 1) {
    return { error: matches.length ? "Ambiguous model ID; use adapter-id/model-id." : "Model '" + raw + "' not found. Check GET /v1/models." };
  }
  const adapter = matches[0];
  if (thinking && !adapter.schema.thinking) return { error: "Adapter '" + adapter.id + "' does not support -think." };
  if (search && !adapter.schema.deepSearch) return { error: "Adapter '" + adapter.id + "' does not support -search." };
  return { adapter, model, thinking, search };
}

function extractChunk(obj, customPath) {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj.choices)) {
    const c = obj.choices[0];
    if (c && typeof c === "object") {
      const d = c.delta || {};
      const m = c.message || {};
      const content = typeof d.content === "string" ? d.content : typeof m.content === "string" ? m.content : typeof c.text === "string" ? c.text : "";
      const reasoning = typeof d.reasoning_content === "string" ? d.reasoning_content : typeof m.reasoning_content === "string" ? m.reasoning_content : "";
      return { content, reasoning, finish: typeof c.finish_reason === "string" ? c.finish_reason : null, usage: obj.usage };
    }
    if (obj.usage) return { content: "", reasoning: "", finish: null, usage: obj.usage };
  }
  if (obj.type === "content_block_delta" && obj.delta) {
    return { content: typeof obj.delta.text === "string" ? obj.delta.text : "", reasoning: typeof obj.delta.thinking === "string" ? obj.delta.thinking : "", finish: null };
  }
  if (Array.isArray(obj.content)) {
    const text = obj.content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("");
    if (text) return { content: text, reasoning: "", finish: "stop", usage: obj.usage };
  }
  if (Array.isArray(obj.candidates) && obj.candidates[0]?.content?.parts) {
    const text = obj.candidates[0].content.parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
    return { content: text, reasoning: "", finish: obj.candidates[0].finishReason ? "stop" : null };
  }
  if (customPath && customPath.length) {
    const v = getPath(obj, customPath);
    if (typeof v === "string") return { content: v, reasoning: "", finish: obj.done === true ? "stop" : null, usage: obj.usage };
  }
  const fields = [
    typeof obj.delta === "string" ? obj.delta : undefined,
    obj.delta && obj.delta.content, obj.delta && obj.delta.text,
    obj.message && obj.message.content, obj.message && obj.message.text,
    obj.content, obj.response, obj.reply, obj.answer, obj.output_text, obj.output,
    obj.token, obj.chunk, obj.text, obj.completion, obj.result,
    obj.data && obj.data.content, obj.data && obj.data.text, obj.data && obj.data.delta,
  ];
  const val = fields.find((v) => typeof v === "string");
  if (val !== undefined) return { content: val, reasoning: typeof obj.reasoning_content === "string" ? obj.reasoning_content : "", finish: obj.done === true || obj.finished === true ? "stop" : null, usage: obj.usage };
  return null;
}

function parseFrame(raw, customPath) {
  const t = raw.trim();
  if (!t) return null;
  if (t === "[DONE]" || t === "DONE" || t === "[END]") return "done";
  const vm = t.match(/^0:("(?:[^"\\\\]|\\\\.)*")$/);
  if (vm) { try { return { content: JSON.parse(vm[1]), reasoning: "", finish: null }; } catch { return null; } }
  if (t.startsWith("{")) { try { return extractChunk(JSON.parse(t), customPath); } catch { return null; } }
  return null;
}

async function* iterateStream(body) {
  if (!body) return;
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "", sse = [], sawSse = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buf += dec.decode(value, { stream: !done });
      const lines = buf.split(/\\r?\\n/);
      buf = done ? "" : lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t) { if (sse.length) { yield { raw: sse.join("\\n"), isSse: true }; sse = []; } continue; }
        if (line.startsWith("data:")) { sawSse = true; sse.push(line.slice(5).trimStart()); }
        else if (/^(?:event|id|retry):|^:/.test(line)) sawSse = true;
        else if (!sawSse && (t.startsWith("{") || /^[0ed]:/.test(t))) yield { raw: t, isSse: false };
      }
      if (done) { if (sse.length) yield { raw: sse.join("\\n"), isSse: true }; break; }
    }
  } finally { try { await reader.cancel(); } catch {} }
}

function buildHeaders(adapter, defaultCT) {
  const h = new Headers();
  const multi = adapter.schema.bodyFormat === "multipart";
  for (const [k, v] of Object.entries(adapter.headers || {})) {
    if (multi && k.toLowerCase() === "content-type") continue;
    h.set(k, v);
  }
  if (defaultCT && !multi && !h.has("content-type")) h.set("content-type", defaultCT);
  if (adapter.origin) h.set("origin", adapter.origin);
  if (adapter.referer) h.set("referer", adapter.referer);
  return h;
}

function callUpstream(adapter, model, messages, stream, thinking, search, signal) {
  if (adapter.method === "GET") {
    const u = new URL(adapter.endpoint);
    u.searchParams.set(adapter.schema.queryParam || adapter.schema.messages[0] || "prompt", formatPrompt(messages));
    if (adapter.schema.model && adapter.schema.model.length === 1 && model) u.searchParams.set(adapter.schema.model[0], model);
    if (adapter.schema.thinking && adapter.schema.thinking.length === 1) u.searchParams.set(adapter.schema.thinking[0], String(thinking));
    if (adapter.schema.deepSearch && adapter.schema.deepSearch.length === 1) u.searchParams.set(adapter.schema.deepSearch[0], String(search));
    const h = buildHeaders(adapter);
    if (!h.has("accept")) h.set("accept", "text/event-stream, application/json");
    return fetch(u.toString(), { method: "GET", headers: h, signal });
  }
  if (adapter.schema.queryParam && Object.keys(adapter.requestTemplate || {}).length === 0) {
    const u = new URL(adapter.endpoint);
    u.searchParams.set(adapter.schema.queryParam, formatPrompt(messages));
    if (adapter.schema.model && adapter.schema.model.length === 1 && model) u.searchParams.set(adapter.schema.model[0], model);
    return fetch(u.toString(), { method: "POST", headers: buildHeaders(adapter), signal });
  }
  const body = JSON.parse(JSON.stringify(adapter.requestTemplate || {}));
  const mode = adapter.schema.inputMode || "messages";
  if (mode === "prompt") setPath(body, adapter.schema.messages, formatPrompt(messages));
  else if (mode === "gemini") {
    const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\\n\\n");
    const contents = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    setPath(body, adapter.schema.messages, contents.length ? contents : [{ role: "user", parts: [{ text: sys }] }]);
    if (sys && contents.length) body.systemInstruction = { parts: [{ text: sys }] };
  } else setPath(body, adapter.schema.messages, messages);
  if (adapter.schema.model && adapter.schema.model.length) setPath(body, adapter.schema.model, model);
  if (adapter.schema.stream && adapter.schema.stream.length) setPath(body, adapter.schema.stream, stream);
  if (adapter.schema.thinking && adapter.schema.thinking.length) setPath(body, adapter.schema.thinking, thinking);
  if (adapter.schema.deepSearch && adapter.schema.deepSearch.length) setPath(body, adapter.schema.deepSearch, search);

  const fmt = adapter.schema.bodyFormat || "json";
  let payload, defaultCT;
  if (fmt === "text" && adapter.schema.messages.length === 1 && adapter.schema.messages[0] === "__rawText") {
    payload = formatPrompt(messages); defaultCT = "text/plain;charset=UTF-8";
  } else if (fmt === "multipart") {
    const fd = new FormData();
    for (const [k, v] of Object.entries(body)) if (v != null) fd.append(k, typeof v === "string" ? v : JSON.stringify(v));
    payload = fd;
  } else if (fmt === "urlencoded") {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (v != null) sp.set(k, typeof v === "string" ? v : JSON.stringify(v));
    payload = sp.toString(); defaultCT = "application/x-www-form-urlencoded";
  } else if (fmt === "text") {
    payload = JSON.stringify(body); defaultCT = "text/plain;charset=UTF-8";
  } else {
    payload = JSON.stringify(body); defaultCT = "application/json";
  }
  return fetch(adapter.endpoint, { method: "POST", headers: buildHeaders(adapter, defaultCT), body: payload, signal });
}

async function handleChat(request, scoped) {
  let body;
  try { body = await request.json(); } catch { return errRes("Invalid JSON body.", 400, "invalid_json"); }
  if (!body || typeof body.model !== "string" || !Array.isArray(body.messages) || !body.messages.length) {
    return errRes("Provide a valid model and non-empty messages array.", 400, "invalid_request");
  }
  const messages = body.messages.map((m) => ({
    role: m.role === "developer" ? "system" : String(m.role || "user"),
    content: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((p) => p && p.type === "text").map((p) => p.text).join("\\n") : "",
  }));
  const r = resolveModel(body.model, scoped);
  if (r.error) return errRes(r.error, 404, "model_not_found");
  const { adapter, model, thinking, search } = r;
  if (adapter.method === "WS") {
    return errRes("WebSocket adapters require a direct WebSocket client or local Proxy Studio.", 501, "websocket_not_supported");
  }
  const stream = body.stream === true;
  let up;
  try { up = await callUpstream(adapter, model, messages, stream, thinking, search, request.signal); }
  catch (e) { return errRes("Upstream connection failed: " + (e && e.message || e), 502, "upstream_unavailable", "api_error"); }
  if (!up.ok) return errRes("Upstream returned HTTP " + up.status + ".", up.status >= 400 && up.status < 600 ? up.status : 502, "upstream_error", "api_error");

  const id = "chatcmpl-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const created = Math.floor(Date.now() / 1000);
  const cp = adapter.schema.responseTextPath;
  const ct = (up.headers.get("content-type") || "").toLowerCase();
  const isNdjson = ct.includes("ndjson") || ct.includes("jsonl");
  const isJson = ct.includes("json") && !ct.includes("event-stream") && !isNdjson;
  const isPlain = ct.includes("text/plain") && !ct.includes("event-stream");
  const wantUsage = !!(body.stream_options && body.stream_options.include_usage);

  if (!stream) {
    let content = "", reasoning = "", finish = "stop", usage;
    if (isJson) {
      const p = extractChunk(await up.json(), cp);
      if (p) { content = p.content; reasoning = p.reasoning; finish = p.finish || "stop"; usage = p.usage; }
    } else if (isPlain) {
      const txt = await up.text();
      if (txt.trim().startsWith("{")) { try { const p = extractChunk(JSON.parse(txt), cp); content = p ? p.content : txt; } catch { content = txt; } }
      else content = txt;
    } else {
      for await (const { raw, isSse } of iterateStream(up.body)) {
        const p = parseFrame(raw, cp);
        if (p === "done") break;
        if (p) { content += p.content; reasoning += p.reasoning; if (p.finish) finish = p.finish; if (p.usage) usage = p.usage; }
        else if (isSse && raw && !raw.trim().startsWith("{")) content += raw;
      }
    }
    return jsonRes({
      id, object: "chat.completion", created, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: finish, logprobs: null }],
      ...(usage ? { usage } : {}),
    });
  }

  const enc = new TextEncoder();
  const sseBody = new ReadableStream({
    async start(ctrl) {
      const emit = (d, f = null) => ctrl.enqueue(enc.encode("data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta: d, finish_reason: f, logprobs: null }] }) + "\\n\\n"));
      let finish = "stop", usage;
      try {
        emit({ role: "assistant" });
        if (isJson) {
          const p = extractChunk(await up.json(), cp);
          if (p) { if (p.reasoning) emit({ reasoning_content: p.reasoning }); if (p.content) emit({ content: p.content }); finish = p.finish || "stop"; usage = p.usage; }
        } else if (isPlain) {
          const txt = await up.text();
          if (txt) emit({ content: txt });
        } else {
          for await (const { raw, isSse } of iterateStream(up.body)) {
            const p = parseFrame(raw, cp);
            if (p === "done") break;
            if (p) {
              if (p.reasoning) emit({ reasoning_content: p.reasoning });
              if (p.content) emit({ content: p.content });
              if (p.finish) finish = p.finish;
              if (p.usage) usage = p.usage;
            } else if (isSse && raw && !raw.trim().startsWith("{")) {
              emit({ content: raw });
            }
          }
        }
        emit({}, finish);
        if (wantUsage && usage) ctrl.enqueue(enc.encode("data: " + JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices: [], usage }) + "\\n\\n"));
        ctrl.enqueue(enc.encode("data: [DONE]\\n\\n"));
      } catch {
        ctrl.enqueue(enc.encode("data: " + JSON.stringify({ error: { message: "Upstream stream interrupted.", type: "api_error" } }) + "\\n\\ndata: [DONE]\\n\\n"));
      } finally { ctrl.close(); }
    },
    async cancel() { try { await up.body?.cancel(); } catch {} },
  });
  return new Response(sseBody, {
    headers: { ...CORS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}

async function route(request, apiKey) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && (pathname === "/" || pathname === "/health" || pathname === "/api/health")) {
    return jsonRes({ ok: true, name: "Proxy Studio Personal Gateway", adapters: ADAPTERS.map((a) => ({ id: a.id, name: a.name, models: a.models.length })), baseUrl: "/v1" });
  }
  if (!checkAuth(request, apiKey)) return errRes("Invalid or missing API key.", 401, "invalid_api_key", "authentication_error");
  if (request.method === "GET" && pathname === "/v1/models") return jsonRes(buildModelsList());
  if (request.method === "POST" && pathname === "/v1/chat/completions") return handleChat(request);
  const m = pathname.match(/^\\/proxy\\/([^/]+)\\/v1\\/(models|chat\\/completions)$/);
  if (m) {
    const adapterId = decodeURIComponent(m[1]);
    if (m[2] === "models" && request.method === "GET") {
      const list = buildModelsList(adapterId);
      return list ? jsonRes(list) : errRes("Adapter not found.", 404, "adapter_not_found");
    }
    if (m[2] === "chat/completions" && request.method === "POST") return handleChat(request, adapterId);
  }
  return errRes("Not found. OpenAI-compatible routes: GET /v1/models and POST /v1/chat/completions.", 404, "not_found");
}`;
}

/** Generate a ready-to-deploy zero-dependency Cloudflare Worker using the user's own free 100k/day quota. */
export function generateCloudflareWorker(adapters: Adapter[], options: ExportOptions = {}): string {
  const baked = bakeAdapters(adapters, Boolean(options.includeCredentials));
  const engine = buildSharedEngine(baked, options.apiKey || "");
  return `/**
 * Proxy Studio — Personal OpenAI-Compatible Gateway (Cloudflare Worker)
 * Generated: ${new Date().toISOString()}
 * Adapters baked in: ${baked.map((a) => `${a.name} (${a.models.length} models)`).join(", ") || "none"}
 *
 * Uses YOUR OWN free Cloudflare Workers quota (100,000 requests/day free).
 * Optional security: set an API_KEY secret via \`npx wrangler secret put API_KEY\`
 * or in Cloudflare Dashboard -> Settings -> Variables & Secrets.
 *
 * Client Base URL: https://<your-worker>.<your-subdomain>.workers.dev/v1
 * Isolated route:  https://<your-worker>.<your-subdomain>.workers.dev/proxy/<adapterId>/v1
 * Suffix routing:  append -think, -search, or -think-search to supported model IDs.
 */

${engine}

export default {
  async fetch(request, env) {
    const apiKey = (env && env.API_KEY) || DEFAULT_API_KEY;
    return route(request, apiKey);
  },
};
`;
}

/** Generate matching wrangler.toml for 1-command deployment (`npx wrangler deploy`). */
export function generateWranglerToml(workerName = "my-ai-proxy-gateway"): string {
  const clean =
    workerName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "my-ai-proxy-gateway";
  return `name = "${clean}"
main = "worker.js"
compatibility_date = "2025-11-01"

# Optional: protect your personal endpoint with a bearer token (recommended!).
# Set securely with:  npx wrangler secret put API_KEY
# Then pass:          Authorization: Bearer <your-key>
`;
}

/** Generate a zero-dependency standalone local Node.js 18+ companion proxy (`proxy.mjs`). */
export function generateLocalProxyScript(adapters: Adapter[], options: ExportOptions = {}): string {
  const baked = bakeAdapters(adapters, Boolean(options.includeCredentials));
  const port = options.port && options.port >= 1 && options.port <= 65535 ? Math.floor(options.port) : 8088;
  const engine = buildSharedEngine(baked, options.apiKey || "");
  return `#!/usr/bin/env node
/**
 * Proxy Studio — Personal Local OpenAI-Compatible Proxy (Zero Dependencies!)
 * Generated: ${new Date().toISOString()}
 * Adapters: ${baked.map((a) => `${a.name} (${a.models.length} models)`).join(", ") || "none"}
 *
 * Requires Node.js 18+ (no npm install needed, zero cloud quota usage!).
 * Start:    node proxy.mjs       (or double-click start-mac.command / start-windows.bat)
 * Base URL: http://127.0.0.1:${port}/v1  (paste directly into Magpie, Cherry Studio, Cursor, etc.)
 * Optional: PORT=9000 API_KEY=my-secret node proxy.mjs
 */
import http from "node:http";
import { Readable } from "node:stream";

const PORT = Number(process.env.PORT || ${port});
const HOST = process.env.HOST || "127.0.0.1";
const API_KEY = process.env.API_KEY || "";

${engine}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = "http://" + (req.headers.host || HOST + ":" + PORT) + (req.url || "/");
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });

  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
    const init = { method: req.method || "GET", headers, signal: ac.signal };
    if (hasBody) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      init.body = Buffer.concat(chunks);
    }
    const response = await route(new Request(url, init), API_KEY || DEFAULT_API_KEY);
    const outHeaders = {};
    response.headers.forEach((v, k) => { outHeaders[k] = v; });
    res.writeHead(response.status, outHeaders);
    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body);
      nodeStream.on("error", () => { if (!res.writableEnded) res.end(); });
      nodeStream.pipe(res);
    } else {
      res.end();
    }
    res.on("finish", () => {
      if (req.method !== "OPTIONS") {
        console.log("[" + new Date().toLocaleTimeString() + "] " + req.method + " " + (req.url || "/") + " -> " + response.status + " (" + (Date.now() - started) + "ms)");
      }
    });
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ error: { message: err && err.message || "Internal proxy error", type: "api_error" } }));
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  const addr = "http://" + (HOST === "0.0.0.0" ? "127.0.0.1" : HOST) + ":" + PORT;
  console.log("\\n  Proxy Studio Local Companion is running! (Zero cloud quota)\\n");
  console.log("  OpenAI Base URL:  " + addr + "/v1");
  console.log("  Models endpoint:  " + addr + "/v1/models");
  console.log("  Adapters loaded:  " + ADAPTERS.length + " (" + ADAPTERS.map((a) => a.id).join(", ") + ")");
  console.log("  Press Ctrl+C to stop.\\n");
});
`;
}

/** Generate zero-install macOS double-click launcher paired with proxy.mjs. */
export function generateMacCompanionLauncher(port = 8088): string {
  return `#!/bin/bash
cd "$(dirname "$0")" || exit 1
printf '\\n  Proxy Studio — Local Companion Proxy\\n\\n'
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 18+ is required. Install it free from https://nodejs.org, then double-click this file again.'
  read -r -p 'Press Return to close...'
  exit 1
fi
if [ ! -f proxy.mjs ]; then
  echo 'Put proxy.mjs in the same folder as this start-mac.command file, then double-click again.'
  read -r -p 'Press Return to close...'
  exit 1
fi
PORT="\${PORT:-${port}}"
export PORT
echo "Tip: paste  http://127.0.0.1:\${PORT}/v1  into Magpie, Cherry Studio, or any OpenAI client."
echo ""
node proxy.mjs
read -r -p 'Proxy stopped. Press Return to close...'
`;
}

/** Generate zero-install Windows double-click launcher paired with proxy.mjs. */
export function generateWindowsCompanionLauncher(port = 8088): string {
  return `@echo off
cd /d "%~dp0"
echo.
echo   Proxy Studio - Local Companion Proxy
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ is required. Install it free from https://nodejs.org then double-click again.
  pause
  exit /b 1
)
if not exist proxy.mjs (
  echo Put proxy.mjs in the same folder as start-windows.bat then double-click again.
  pause
  exit /b 1
)
if "%PORT%"=="" set PORT=${port}
echo Paste http://127.0.0.1:%PORT%/v1 into Magpie, Cherry Studio, or any OpenAI client.
echo.
node proxy.mjs
pause
`;
}
