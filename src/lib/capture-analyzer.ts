import JSON5 from "json5";
import { extractStreamPayload, extractText, getPath } from "@/lib/response-parser";
import type {
  Adapter,
  AdapterSchema,
  BodyFormat,
  CaptureTransport,
  InputMode,
  Model,
  ResponseFormat,
} from "@/lib/types";

export type CapturedPayload = {
  sessionId?: string;
  transport?: CaptureTransport;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  pageUrl?: string;
  pageOrigin?: string;
  bodyFormat?: BodyFormat;
  requestBody?: unknown;
  responseStatus?: number;
  responseContentType?: string;
  responseSample?: string;
  looksLikeChat?: boolean;
  capturedAt?: string;
};

export type AnalyzeOutcome =
  | {
      accepted: false;
      kind: "telemetry" | "secondary";
      message: string;
      actionTip: string;
      cleanEndpoint: string;
    }
  | {
      accepted: true;
      adapter: Adapter;
      transport: CaptureTransport;
      bodyFormat: BodyFormat;
      inferredFormat: ResponseFormat;
      schemaFields: string[];
      cleanEndpoint: string;
    };

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const TELEMETRY_URL_RE =
  /(?:firestore\.googleapis\.com|firebase(?:installations|logging)?\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|firebaseio\.com|google-analytics\.com|googletagmanager\.com|googlesyndication\.com|googleadservices\.com|doubleclick\.net|sentry\.io|ingest\.sentry|datadoghq\.com|mixpanel\.com|segment\.(?:io|com)|amplitude\.com|posthog\.com|hotjar\.com|clarity\.ms|plausible\.io|cloudflareinsights\.com|intercom\.io|logrocket\.com|bugsnag\.com|rollbar\.com|launchdarkly\.com|statsig\.com|newrelic\.com|fullstory\.com|heap\.io|hcaptcha\.com|recaptcha\.net|challenges\.cloudflare\.com|documents:commit|documents:batchGet|documents:listen|google\.firestore|\/cdn-cgi\/|\/gtag\/|\/collect(?:\?|$)|\/beacon|\/telemetry|\/analytics|\/metrics(?:[/?]|$)|\/logs?(?:[/?]|$))/i;

const STATIC_ASSET_RE =
  /\.(?:m?js|cjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot|otf|map|wasm|mp[34]|wav|ogg|webm|pdf|zip)(?:[?#]|$)/i;

const SECONDARY_PATH_RE =
  /\/(?:auth|login|logout|signup|register|token|refresh|session|user|users|profile|me|account|billing|subscription|checkout|stripe|credits|quota|usage|settings|preferences|feedback|ping|health|status|config|flags|notifications|referral|leaderboard|history\/list|conversations\/list)(?:[/?]|$)/i;

const META_STRING_KEYS = new Set([
  "id",
  "uid",
  "uuid",
  "object",
  "type",
  "event",
  "action",
  "op",
  "method",
  "model",
  "modelid",
  "model_id",
  "modelname",
  "model_name",
  "role",
  "finish_reason",
  "stop_reason",
  "status",
  "created",
  "created_at",
  "createdat",
  "updated_at",
  "updatedat",
  "timestamp",
  "conversation_id",
  "conversationid",
  "chat_id",
  "chatid",
  "thread_id",
  "threadid",
  "parent_id",
  "parentid",
  "message_id",
  "messageid",
  "request_id",
  "requestid",
  "session_id",
  "sessionid",
  "user_id",
  "userid",
  "client_id",
  "clientid",
  "token",
  "csrf",
  "nonce",
  "signature",
  "key",
  "apikey",
  "api_key",
  "lang",
  "language",
  "locale",
  "timezone",
  "tz",
  "version",
  "v",
  "source",
  "origin",
  "referer",
  "url",
  "href",
  "error",
  "code",
  "mode",
  "channel",
  "namespace",
  "provider",
  "region",
  "platform",
  "ua",
  "useragent",
  "user_agent",
  "email",
  "username",
  "password",
]);

export function sanitizeEndpointDisplay(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(rawUrl || "").slice(0, 140);
  }
}

function findPath(
  obj: unknown,
  candidates: string[],
  predicate: (value: unknown) => boolean,
  depth = 0,
  prefix: string[] = [],
): string[] | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || depth > 4) return null;
  const record = obj as Record<string, unknown>;
  for (const key of candidates) {
    if (
      !BLOCKED_KEYS.has(key) &&
      Object.prototype.hasOwnProperty.call(record, key) &&
      predicate(record[key])
    ) {
      return [...prefix, key];
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (BLOCKED_KEYS.has(key) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const nested = findPath(value, candidates, predicate, depth + 1, [...prefix, key]);
    if (nested) return nested;
  }
  return null;
}

/** Fallback: locate a likely natural-language prompt string under an unusual key name. */
function findCustomPromptPath(
  obj: unknown,
  depth = 0,
  prefix: string[] = [],
): { path: string[]; score: number } | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || depth > 3) return null;
  let best: { path: string[]; score: number } | null = null;
  const rec = obj as Record<string, unknown>;
  for (const [key, val] of Object.entries(rec)) {
    if (BLOCKED_KEYS.has(key)) continue;
    const lk = key.toLowerCase();
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (!trimmed || trimmed.length > 20_000) continue;
      if (META_STRING_KEYS.has(lk) || /(?:_?id|token|secret|hash|sig|nonce|key|url|uri|email|pass|date|time|color|mime|type)$/i.test(key)) {
        continue;
      }
      if (/^https?:\/\//i.test(trimmed) || /^\[file:/.test(trimmed)) continue;
      if (/^[a-f0-9-]{20,}$/i.test(trimmed) || /^[A-Za-z0-9_-]{32,}$/.test(trimmed)) continue;
      if (/^(?:true|false|null|undefined|ok|en|en-US|\d+(?:\.\d+)?)$/i.test(trimmed)) continue;
      let score = trimmed.length;
      if (/\s/.test(trimmed)) score += 40;
      if (/(?:prompt|msg|message|chat|text|say|speak|ask|input|query|instruction|utterance|content|body|question|reply|human|user)/i.test(key)) {
        score += 120;
      }
      const candidate = { path: [...prefix, key], score };
      if (!best || candidate.score > best.score) best = candidate;
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = findCustomPromptPath(val, depth + 1, [...prefix, key]);
      if (nested && (!best || nested.score > best.score)) best = nested;
    }
  }
  return best;
}

function isNonEmptyMessagesArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const r = item as Record<string, unknown>;
    return (
      typeof r.content === "string" ||
      Array.isArray(r.content) ||
      typeof r.text === "string" ||
      typeof r.role === "string" ||
      typeof r.message === "string" ||
      typeof r.author === "string"
    );
  });
}

function isGeminiContentsArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const r = item as Record<string, unknown>;
    return (
      Array.isArray(r.parts) &&
      (r.parts as unknown[]).some(
        (p) => p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string",
      )
    );
  });
}

function isTelemetryBody(body: Record<string, unknown>): boolean {
  if (Array.isArray(body.writes) && body.writes.length > 0) return true;
  if (
    ("used" in body || "totalUsed" in body || "weeklyTokens" in body || "bonusTokens" in body) &&
    !("messages" in body) &&
    !("prompt" in body) &&
    !("query" in body)
  ) {
    return true;
  }
  if (
    ("event" in body || "events" in body || "eventName" in body || "event_name" in body) &&
    ("timestamp" in body || "anonymousId" in body || "distinct_id" in body || "sentry" in body || "properties" in body)
  ) {
    return true;
  }
  return false;
}

function findCustomTextPath(obj: unknown, depth = 0, prefix: string[] = []): string[] | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || depth > 3) return null;
  const preferred = [
    "text",
    "content",
    "delta",
    "token",
    "chunk",
    "reply",
    "answer",
    "response",
    "output",
    "output_text",
    "message",
    "generated_text",
    "completion",
    "result",
    "assistant",
    "say",
  ];
  const rec = obj as Record<string, unknown>;
  for (const key of preferred) {
    if (typeof rec[key] === "string" && (rec[key] as string).length > 0) {
      return [...prefix, key];
    }
  }
  for (const [key, val] of Object.entries(rec)) {
    if (BLOCKED_KEYS.has(key) || META_STRING_KEYS.has(key.toLowerCase())) continue;
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = findCustomTextPath(val, depth + 1, [...prefix, key]);
      if (nested) return nested;
    }
  }
  for (const [key, val] of Object.entries(rec)) {
    if (BLOCKED_KEYS.has(key) || META_STRING_KEYS.has(key.toLowerCase())) continue;
    if (
      typeof val === "string" &&
      val.trim().length > 0 &&
      !/^https?:\/\//i.test(val) &&
      !/^[a-f0-9-]{20,}$/i.test(val)
    ) {
      return [...prefix, key];
    }
  }
  return null;
}

function clearAtPath(target: Record<string, unknown>, path: string[], replacement: unknown) {
  if (!path.length) return;
  let cur: Record<string, unknown> = target;
  for (const seg of path.slice(0, -1)) {
    if (BLOCKED_KEYS.has(seg)) return;
    const next = cur[seg];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    cur = next as Record<string, unknown>;
  }
  const leaf = path[path.length - 1];
  if (!BLOCKED_KEYS.has(leaf)) cur[leaf] = replacement;
}

function tryDecodeBody(
  rawBody: unknown,
  hintFormat: BodyFormat | undefined,
  reqContentType: string,
): { body: Record<string, unknown> | null; bodyFormat: BodyFormat } {
  const ct = reqContentType.toLowerCase();
  const isTextCt = ct.includes("text/plain");
  const isFormCt = ct.includes("x-www-form-urlencoded");
  const isMultiCt = ct.includes("multipart/form-data");

  if (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)) {
    const format: BodyFormat =
      hintFormat || (isMultiCt ? "multipart" : isFormCt ? "urlencoded" : isTextCt ? "text" : "json");
    return { body: structuredClone(rawBody as Record<string, unknown>), bodyFormat: format };
  }

  if (typeof rawBody === "string") {
    const trimmed = rawBody.trim();
    if (!trimmed) return { body: null, bodyFormat: hintFormat || "json" };

    // 1. JSON string (including text/plain carrying JSON string!)
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const fmt: BodyFormat = hintFormat === "text" || isTextCt ? "text" : "json";
          return { body: parsed as Record<string, unknown>, bodyFormat: fmt };
        }
      } catch {
        try {
          const parsed = JSON5.parse(trimmed);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return { body: parsed as Record<string, unknown>, bodyFormat: isTextCt ? "text" : "json" };
          }
        } catch {
          /* continue to urlencoded fallback */
        }
      }
    }

    // 2. application/x-www-form-urlencoded or key=value&key2=value2 string
    if (
      hintFormat === "urlencoded" ||
      isFormCt ||
      (trimmed.includes("=") && !trimmed.includes("\n") && /^[^\s{[<][^=&]*=/.test(trimmed))
    ) {
      const sp = new URLSearchParams(trimmed);
      const obj: Record<string, unknown> = {};
      let count = 0;
      sp.forEach((v, k) => {
        if (count >= 60 || BLOCKED_KEYS.has(k)) return;
        count++;
        const vt = v.trim();
        if (vt.startsWith("{") || vt.startsWith("[")) {
          try {
            obj[k] = JSON.parse(vt);
            return;
          } catch {
            /* keep raw string */
          }
        }
        if (vt === "true") obj[k] = true;
        else if (vt === "false") obj[k] = false;
        else obj[k] = v;
      });
      if (count > 0) {
        return { body: obj, bodyFormat: "urlencoded" };
      }
    }

    // 3. Bare raw text prompt (e.g. text/plain POST body "Hello!")
    if (trimmed.length >= 1 && trimmed.length < 16_000 && !trimmed.startsWith("<")) {
      return { body: { __rawText: trimmed }, bodyFormat: "text" };
    }
  }

  return { body: null, bodyFormat: hintFormat || "json" };
}

export function detectResponseFormat(
  contentType: string,
  sample: string,
  isWebSocket = false,
): {
  format: ResponseFormat;
  recognized: boolean;
  discoveredModel?: string;
  customTextPath?: string[];
} {
  const ct = (contentType || "").toLowerCase();
  const trimmed = (sample || "").trim();

  if (isWebSocket || ct.includes("websocket")) {
    let discoveredModel: string | undefined;
    let customTextPath: string[] | undefined;
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines.slice(0, 10)) {
      if (line.startsWith("{")) {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (typeof obj.model === "string" && !discoveredModel) discoveredModel = obj.model;
          const hit = extractText(obj);
          if (hit.matched) return { format: "websocket", recognized: true, discoveredModel };
          if (!customTextPath) customTextPath = findCustomTextPath(obj) ?? undefined;
        } catch {
          /* ignore */
        }
      }
    }
    return {
      format: "websocket",
      recognized: lines.length > 0,
      discoveredModel,
      customTextPath,
    };
  }

  const looksSse = ct.includes("text/event-stream") || /^data:\s*/m.test(trimmed);
  const looksNdjson = ct.includes("ndjson") || ct.includes("jsonl");

  if (looksSse) {
    const dataLines = trimmed
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((d) => d && d !== "[DONE]");

    let discoveredModel: string | undefined;
    let customTextPath: string[] | undefined;

    for (const raw of dataLines) {
      const parsed = extractStreamPayload(raw);
      if (parsed && parsed !== "done" && parsed.matched) {
        if (parsed.model) discoveredModel = parsed.model;
        if (parsed.format === "openai-sse") {
          return { format: "openai-sse", recognized: true, discoveredModel };
        }
        if (parsed.format === "anthropic-sse") {
          return { format: "anthropic-sse", recognized: true, discoveredModel };
        }
        return { format: "custom-sse", recognized: true, discoveredModel };
      }
      if (raw.startsWith("{")) {
        try {
          const obj = JSON.parse(raw) as Record<string, unknown>;
          if (!discoveredModel && typeof obj.model === "string") discoveredModel = obj.model;
          const p = findCustomTextPath(obj);
          if (p) customTextPath = p;
        } catch {
          /* ignore */
        }
      }
    }
    if (customTextPath) {
      return { format: "custom-sse", recognized: true, discoveredModel, customTextPath };
    }
    if (dataLines.length > 0 && dataLines.some((d) => !d.startsWith("{"))) {
      return { format: "custom-sse", recognized: true, discoveredModel };
    }
    return { format: "custom-sse", recognized: ct.includes("text/event-stream"), discoveredModel };
  }

  // Vercel AI SDK Data Stream lines: `0:"Hello"`
  if (/^0:"/m.test(trimmed)) {
    return { format: "custom-sse", recognized: true };
  }

  // NDJSON (newline-delimited JSON objects)
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if ((looksNdjson || lines.length >= 2) && lines.every((l) => l.startsWith("{"))) {
    let discoveredModel: string | undefined;
    let customTextPath: string[] | undefined;
    for (const line of lines.slice(0, 8)) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (typeof obj.model === "string" && !discoveredModel) discoveredModel = obj.model;
        const hit = extractText(obj);
        if (hit.matched) return { format: "ndjson", recognized: true, discoveredModel };
        if (!customTextPath) customTextPath = findCustomTextPath(obj) ?? undefined;
      } catch {
        /* ignore */
      }
    }
    if (customTextPath) {
      return { format: "ndjson", recognized: true, discoveredModel, customTextPath };
    }
    if (looksNdjson) return { format: "ndjson", recognized: true, discoveredModel };
  }

  // Standard single JSON response
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const hit = extractText(obj);
      if (hit.matched) {
        return { format: "json", recognized: true, discoveredModel: hit.model };
      }
      const p = findCustomTextPath(obj);
      if (p) {
        const discoveredModel = typeof obj.model === "string" ? obj.model : undefined;
        return { format: "json", recognized: true, discoveredModel, customTextPath: p };
      }
    } catch {
      /* truncated JSON sample */
    }
  }

  // Plain-text streaming/reply (e.g. text/plain assistant reply)
  if (ct.includes("text/plain") && trimmed.length >= 2 && !trimmed.startsWith("<")) {
    return { format: "custom-sse", recognized: true };
  }

  return { format: ct.includes("json") ? "json" : "openai-sse", recognized: false };
}

function sanitizeHeaders(raw?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  const entries = Object.entries(raw).slice(0, 50);
  for (const [k, v] of entries) {
    if (typeof k !== "string" || typeof v !== "string") continue;
    const key = k.trim();
    if (!key || key.length > 100 || v.length > 16_000) continue;
    if (
      /^(host|content-length|connection|transfer-encoding|accept-encoding|origin|referer|sec-.*|:.*)$/i.test(
        key,
      )
    ) {
      continue;
    }
    out[key] = v;
  }
  return out;
}

function extractModelsFromSample(sample: string): Model[] {
  const out: Model[] = [];
  const seen = new Set<string>();
  const re =
    /"id"\s*:\s*"([a-zA-Z0-9][a-zA-Z0-9._:/-]{1,79})"\s*,\s*"name"\s*:\s*"([^"\n]{1,90})"/g;
  for (const m of sample.matchAll(re)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push({ id: m[1], name: m[2] });
    }
    if (out.length >= 40) break;
  }
  return out;
}

function mergeModels(primaryIds: string[], extra: Model[]): Model[] {
  const merged: Model[] = [];
  const seen = new Set<string>();
  const isValidId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(id);

  for (const raw of primaryIds) {
    const id = raw.trim();
    if (!id || !isValidId(id) || seen.has(id)) continue;
    seen.add(id);
    const match = extra.find((m) => m.id === id);
    merged.push({ id, name: match?.name || id });
  }
  for (const m of extra) {
    if (!m.id || !isValidId(m.id) || seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push({ id: m.id, name: m.name || m.id });
    if (merged.length >= 80) break;
  }
  if (!merged.length) merged.push({ id: "default", name: "default" });
  return merged;
}

function resolveOriginAndReferer(
  endpointUrl: URL,
  payload: CapturedPayload,
  targetUrl: string,
): { origin: string; referer: string; siteUrl: string; displayName: string } {
  const rawHeaders = payload.headers || {};
  const headerOrigin = Object.entries(rawHeaders).find(([k]) => k.toLowerCase() === "origin")?.[1];
  const headerReferer = Object.entries(rawHeaders).find(([k]) => k.toLowerCase() === "referer")?.[1];

  const tryOrigin = (value?: string): string | null => {
    if (!value) return null;
    try {
      const u = new URL(value);
      if (/^https?:$/.test(u.protocol)) return u.origin;
      if (u.protocol === "wss:") return `https://${u.host}`;
      if (u.protocol === "ws:") return `http://${u.host}`;
      return null;
    } catch {
      return null;
    }
  };

  const origin =
    tryOrigin(headerOrigin) ||
    tryOrigin(payload.pageOrigin) ||
    tryOrigin(payload.pageUrl) ||
    tryOrigin(targetUrl) ||
    tryOrigin(endpointUrl.toString()) ||
    "https://example.com";

  let referer = `${origin}/`;
  const refCandidate = headerReferer || payload.pageUrl || targetUrl;
  if (refCandidate) {
    try {
      const u = new URL(refCandidate);
      if (/^https?:$/.test(u.protocol)) referer = u.toString();
    } catch {
      /* keep fallback */
    }
  }

  const host = new URL(origin).hostname.replace(/^www\./, "");
  const label = host.split(".")[0] || "captured";
  const displayName = label.slice(0, 80);

  return { origin, referer, siteUrl: `${origin}/`, displayName };
}

export function analyzeCapture(
  payload: CapturedPayload,
  targetUrl: string,
  preDiscoveredModels: Model[] = [],
): AnalyzeOutcome {
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(payload.url);
  } catch {
    return {
      accepted: false,
      kind: "secondary",
      cleanEndpoint: String(payload.url || "").slice(0, 120),
      message: "Skipped a request that didn't have a valid web address.",
      actionTip: "Keep this panel open and send one message in the chat.",
    };
  }

  const isWs = endpointUrl.protocol === "ws:" || endpointUrl.protocol === "wss:";
  const isHttp = endpointUrl.protocol === "http:" || endpointUrl.protocol === "https:";
  if (!isHttp && !isWs) {
    return {
      accepted: false,
      kind: "secondary",
      cleanEndpoint: sanitizeEndpointDisplay(payload.url),
      message: "Skipped a browser-internal request (not HTTP or WebSocket).",
      actionTip: "Send one normal chat message to capture the real AI call.",
    };
  }

  const cleanEndpoint = sanitizeEndpointDisplay(endpointUrl.toString());
  const transport: CaptureTransport = isWs
    ? "websocket"
    : payload.transport === "xhr" ||
        payload.transport === "eventsource" ||
        payload.transport === "websocket"
      ? payload.transport
      : "fetch";
  const method = isWs ? "WS" : String(payload.method || "POST").toUpperCase();
  const ct = payload.responseContentType || "";
  const sample =
    typeof payload.responseSample === "string" ? payload.responseSample.slice(0, 12_000) : "";

  // 1. Skip static assets and analytics/telemetry/Firestore writes
  if (STATIC_ASSET_RE.test(endpointUrl.pathname) || TELEMETRY_URL_RE.test(endpointUrl.toString())) {
    return {
      accepted: false,
      kind: "telemetry",
      cleanEndpoint,
      message: "Skipped a background analytics or database call (not the AI chat). Still listening for your message.",
      actionTip: "No action needed — type and send 1 message in the chat.",
    };
  }

  const info = resolveOriginAndReferer(endpointUrl, payload, targetUrl);
  const headers = sanitizeHeaders(payload.headers);
  const reqCT =
    Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] || "";
  const respAnalysis = detectResponseFormat(ct, sample, isWs);

  // 2. WebSocket chat endpoints (ws:// or wss://)
  if (isWs || transport === "websocket") {
    const raw = payload.requestBody;
    let bodyObj: Record<string, unknown> | null = null;
    let wsPlainText = false;
    let inputMode: InputMode = "messages";
    let messagesPath: string[] = [];
    let modelPath: string[] | null = null;
    let thinkingPath: string[] | null = null;
    let deepSearchPath: string[] | null = null;

    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      bodyObj = structuredClone(raw as Record<string, unknown>);
    } else if (typeof raw === "string") {
      const t = raw.trim();
      if (t.startsWith("{")) {
        try {
          const p = JSON.parse(t);
          if (p && typeof p === "object" && !Array.isArray(p)) bodyObj = p as Record<string, unknown>;
        } catch {
          /* plain text */
        }
      }
      if (!bodyObj && t.length > 0) {
        wsPlainText = true;
        inputMode = "prompt";
        messagesPath = ["prompt"];
      }
    }

    if (bodyObj) {
      const msgArr = findPath(
        bodyObj,
        ["messages", "conversation", "chat_history", "chatHistory", "history", "turns", "input"],
        isNonEmptyMessagesArray,
      );
      if (msgArr) {
        messagesPath = msgArr;
        inputMode = "messages";
      } else {
        const promptP = findPath(
          bodyObj,
          ["prompt", "message", "content", "text", "query", "input", "question", "ask", "chat", "data"],
          (v) => typeof v === "string" && v.trim().length > 0 && v.length < 20_000,
        );
        if (promptP) {
          messagesPath = promptP;
          inputMode = "prompt";
        } else {
          const custom = findCustomPromptPath(bodyObj);
          if (custom) {
            messagesPath = custom.path;
            inputMode = "prompt";
          }
        }
      }
      if (!messagesPath.length) {
        return {
          accepted: false,
          kind: "secondary",
          cleanEndpoint,
          message: "Saw a WebSocket ping/status message (not your chat text). Still listening for a real chat message.",
          actionTip: "Type a message in the chat window and press Send.",
        };
      }
      modelPath = findPath(
        bodyObj,
        ["modelId", "model", "model_id", "modelName", "model_name", "engine", "bot", "botId"],
        (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 100,
      );
      thinkingPath = findPath(
        bodyObj,
        ["thinking", "enable_thinking", "enableThinking", "deepThink", "reasoning", "think"],
        (v) => typeof v === "boolean",
      );
      deepSearchPath = findPath(
        bodyObj,
        ["deepSearch", "deep_search", "webSearch", "web_search", "search", "online"],
        (v) => typeof v === "boolean",
      );
      clearAtPath(bodyObj, messagesPath, inputMode === "prompt" ? "" : []);
      if (thinkingPath) clearAtPath(bodyObj, thinkingPath, false);
      if (deepSearchPath) clearAtPath(bodyObj, deepSearchPath, false);
    } else if (!wsPlainText) {
      return {
        accepted: false,
        kind: "secondary",
        cleanEndpoint,
        message: "WebSocket opened, waiting for you to send one chat message.",
        actionTip: "Send a short prompt in the chat so we can see its frame shape.",
      };
    }

    const rawModel = bodyObj && modelPath ? getPath(bodyObj, modelPath) : undefined;
    const primary: string[] = [];
    if (typeof rawModel === "string" && rawModel.trim()) primary.push(rawModel.trim());
    else if (respAnalysis.discoveredModel) primary.push(respAnalysis.discoveredModel);

    const models = mergeModels(primary, [...preDiscoveredModels, ...extractModelsFromSample(sample)]);
    const schema: AdapterSchema = {
      messages: messagesPath,
      model: modelPath || [],
      stream: null,
      thinking: thinkingPath,
      deepSearch: deepSearchPath,
      inputMode,
      bodyFormat: wsPlainText ? "text" : "json",
      responseFormat: "websocket",
      ...(wsPlainText ? { wsPlainText: true } : {}),
      ...(respAnalysis.customTextPath ? { responseTextPath: respAnalysis.customTextPath } : {}),
    };

    const adapter: Adapter = {
      id: "",
      name: info.displayName,
      siteUrl: info.siteUrl,
      endpoint: endpointUrl.toString(),
      method: "WS",
      origin: info.origin,
      referer: info.referer,
      enabled: true,
      source: "captured",
      createdAt: new Date().toISOString(),
      verifiedAt: null,
      headers,
      requestTemplate: bodyObj || {},
      schema,
      models,
    };

    return {
      accepted: true,
      adapter,
      transport: "websocket",
      bodyFormat: wsPlainText ? "text" : "json",
      inferredFormat: "websocket",
      schemaFields: [
        wsPlainText ? "ws:text" : `ws:${messagesPath.join(".")}`,
        ...(modelPath ? [modelPath.join(".")] : []),
        ...(thinkingPath ? [thinkingPath.join(".")] : []),
        ...(deepSearchPath ? [deepSearchPath.join(".")] : []),
      ],
      cleanEndpoint,
    };
  }

  // 3. GET / EventSource with query parameters (works for SSE, NDJSON, JSON, AND text/plain!)
  if (method === "GET") {
    const promptKeys = [
      "prompt",
      "message",
      "msg",
      "q",
      "query",
      "input",
      "text",
      "content",
      "ask",
      "instruction",
      "chat",
      "question",
      "userPrompt",
      "user_prompt",
    ];
    let promptParam = promptKeys.find((k) => endpointUrl.searchParams.has(k));
    const modelParam = ["model", "modelId", "model_id", "engine", "modelName"].find((k) =>
      endpointUrl.searchParams.has(k),
    );
    const thinkingParam = ["thinking", "think", "enable_thinking", "reasoning"].find((k) =>
      endpointUrl.searchParams.has(k),
    );
    const searchParam = ["deepSearch", "deep_search", "search", "webSearch", "online"].find((k) =>
      endpointUrl.searchParams.has(k),
    );

    // Permissive fallback: if response clearly looks like chat SSE/LLM JSON and a query param holds text
    if (!promptParam && respAnalysis.recognized) {
      for (const [k, v] of endpointUrl.searchParams.entries()) {
        if (META_STRING_KEYS.has(k.toLowerCase())) continue;
        if (v.trim().length >= 2 && (/\s/.test(v) || v.length >= 4) && !/^\d+$/.test(v)) {
          promptParam = k;
          break;
        }
      }
    }

    const isStreamGet =
      transport === "eventsource" || ct.toLowerCase().includes("text/event-stream");
    const validChatGet = Boolean(
      (promptParam && (isStreamGet || respAnalysis.recognized || payload.looksLikeChat || !ct)) ||
        (isStreamGet && respAnalysis.recognized),
    );

    if (!validChatGet || SECONDARY_PATH_RE.test(endpointUrl.pathname)) {
      return {
        accepted: false,
        kind: "secondary",
        cleanEndpoint,
        message: "Saw a background GET load (not a chat reply). Keep going and send 1 message in the chat.",
        actionTip: "Still listening — send 1 real message in the chat window.",
      };
    }

    const baseModels = mergeModels(
      [
        ...(modelParam ? [endpointUrl.searchParams.get(modelParam) || ""] : []),
        ...(respAnalysis.discoveredModel ? [respAnalysis.discoveredModel] : []),
      ],
      [...preDiscoveredModels, ...extractModelsFromSample(sample)],
    );

    const schema: AdapterSchema = {
      messages: [promptParam || "prompt"],
      model: modelParam ? [modelParam] : [],
      stream: null,
      thinking: thinkingParam ? [thinkingParam] : null,
      deepSearch: searchParam ? [searchParam] : null,
      inputMode: "prompt",
      bodyFormat: "urlencoded",
      responseFormat: isStreamGet
        ? respAnalysis.format === "json"
          ? "custom-sse"
          : respAnalysis.format
        : respAnalysis.format,
      ...(respAnalysis.customTextPath ? { responseTextPath: respAnalysis.customTextPath } : {}),
      queryParam: promptParam || "prompt",
    };

    // Strip the captured prompt string before persisting.
    const cleanTarget = new URL(endpointUrl.toString());
    if (promptParam) cleanTarget.searchParams.set(promptParam, "");

    const adapter: Adapter = {
      id: "",
      name: info.displayName,
      siteUrl: info.siteUrl,
      endpoint: cleanTarget.toString(),
      method: "GET",
      origin: info.origin,
      referer: info.referer,
      enabled: true,
      source: "captured",
      createdAt: new Date().toISOString(),
      verifiedAt: null,
      headers,
      requestTemplate: {},
      schema,
      models: baseModels,
    };

    return {
      accepted: true,
      adapter,
      transport,
      bodyFormat: "urlencoded",
      inferredFormat: schema.responseFormat || "custom-sse",
      schemaFields: [
        `query:${promptParam || "prompt"}`,
        ...(modelParam ? [`query:${modelParam}`] : []),
        ...(thinkingParam ? [`query:${thinkingParam}`] : []),
        ...(searchParam ? [`query:${searchParam}`] : []),
      ],
      cleanEndpoint,
    };
  }

  if (method !== "POST" && method !== "PUT") {
    return {
      accepted: false,
      kind: "secondary",
      cleanEndpoint,
      message: `Skipped a ${method} request — waiting for your chat's reply request.`,
      actionTip: "Type and send 1 message in the chat.",
    };
  }

  // 4. Decode request body across JSON, text/plain JSON, FormData, and URLSearchParams/urlencoded!
  const decoded = tryDecodeBody(payload.requestBody, payload.bodyFormat, reqCT);
  const body = decoded.body;
  const bodyFormat = decoded.bodyFormat;

  // Handle POST with prompt passed in URL query string (some sites like Perchance POST with ?prompt=...)
  if (!body) {
    const qPrompt = ["prompt", "message", "msg", "q", "query", "input", "text", "content", "ask"].find(
      (k) => endpointUrl.searchParams.has(k),
    );
    if (qPrompt && !SECONDARY_PATH_RE.test(endpointUrl.pathname)) {
      const qModel = ["model", "modelId", "model_id"].find((k) => endpointUrl.searchParams.has(k));
      const cleanTarget = new URL(endpointUrl.toString());
      cleanTarget.searchParams.set(qPrompt, "");
      const models = mergeModels(
        [
          ...(qModel ? [endpointUrl.searchParams.get(qModel) || ""] : []),
          ...(respAnalysis.discoveredModel ? [respAnalysis.discoveredModel] : []),
        ],
        [...preDiscoveredModels, ...extractModelsFromSample(sample)],
      );
      const adapter: Adapter = {
        id: "",
        name: info.displayName,
        siteUrl: info.siteUrl,
        endpoint: cleanTarget.toString(),
        method: "POST",
        origin: info.origin,
        referer: info.referer,
        enabled: true,
        source: "captured",
        createdAt: new Date().toISOString(),
        verifiedAt: null,
        headers,
        requestTemplate: {},
        schema: {
          messages: [qPrompt],
          model: qModel ? [qModel] : [],
          stream: null,
          thinking: null,
          deepSearch: null,
          inputMode: "prompt",
          bodyFormat: "json",
          responseFormat: respAnalysis.format,
          ...(respAnalysis.customTextPath ? { responseTextPath: respAnalysis.customTextPath } : {}),
          queryParam: qPrompt,
        },
        models,
      };
      return {
        accepted: true,
        adapter,
        transport,
        bodyFormat: "json",
        inferredFormat: respAnalysis.format,
        schemaFields: [`query:${qPrompt}`, ...(qModel ? [`query:${qModel}`] : [])],
        cleanEndpoint,
      };
    }
    return {
      accepted: false,
      kind: "secondary",
      cleanEndpoint,
      message: "Caught a POST call with no message data inside. Keep listening and send 1 real chat message.",
      actionTip: "Send a chat message on the site to capture the AI call.",
    };
  }

  // Raw plain-text POST body (e.g. text/plain "Hello there!")
  if (Object.keys(body).length === 1 && typeof body.__rawText === "string") {
    if (SECONDARY_PATH_RE.test(endpointUrl.pathname) && !respAnalysis.recognized) {
      return {
        accepted: false,
        kind: "secondary",
        cleanEndpoint,
        message: "Skipped an account/background POST request. Still listening for your chat message.",
        actionTip: "Send 1 message in the chat window.",
      };
    }
    const models = mergeModels(
      respAnalysis.discoveredModel ? [respAnalysis.discoveredModel] : [],
      [...preDiscoveredModels, ...extractModelsFromSample(sample)],
    );
    const outHeaders = { ...headers };
    if (!Object.keys(outHeaders).some((k) => k.toLowerCase() === "content-type")) {
      outHeaders["Content-Type"] = "text/plain;charset=UTF-8";
    }
    const adapter: Adapter = {
      id: "",
      name: info.displayName,
      siteUrl: info.siteUrl,
      endpoint: endpointUrl.toString(),
      method: "POST",
      origin: info.origin,
      referer: info.referer,
      enabled: true,
      source: "captured",
      createdAt: new Date().toISOString(),
      verifiedAt: null,
      headers: outHeaders,
      requestTemplate: { __rawText: "" },
      schema: {
        messages: ["__rawText"],
        model: [],
        stream: null,
        thinking: null,
        deepSearch: null,
        inputMode: "prompt",
        bodyFormat: "text",
        responseFormat: respAnalysis.format,
        ...(respAnalysis.customTextPath ? { responseTextPath: respAnalysis.customTextPath } : {}),
      },
      models,
    };
    return {
      accepted: true,
      adapter,
      transport,
      bodyFormat: "text",
      inferredFormat: respAnalysis.format,
      schemaFields: ["text/plain body"],
      cleanEndpoint,
    };
  }

  // Filter Firestore/usage/telemetry bodies even on custom hostnames
  if (isTelemetryBody(body)) {
    return {
      accepted: false,
      kind: "telemetry",
      cleanEndpoint,
      message: "Skipped a background usage/quota update (like a token tracker). Still listening for the AI chat call.",
      actionTip: "No action needed — send 1 chat message to capture the reply request.",
    };
  }

  // 5. Infer request schema (messages -> Gemini contents -> standard prompt -> permissive unusual prompt field!)
  let inputMode: InputMode = "messages";
  let messagesPath = findPath(
    body,
    ["messages", "conversation", "chat_history", "chatHistory", "history", "turns", "dialog", "dialogue", "input"],
    isNonEmptyMessagesArray,
  );

  if (!messagesPath) {
    const geminiPath = findPath(body, ["contents", "messages"], isGeminiContentsArray);
    if (geminiPath) {
      messagesPath = geminiPath;
      inputMode = "gemini";
    }
  }

  if (!messagesPath) {
    const promptPath = findPath(
      body,
      [
        "prompt",
        "message",
        "query",
        "question",
        "input",
        "userMessage",
        "user_message",
        "userPrompt",
        "user_prompt",
        "instruction",
        "text",
        "content",
        "ask",
        "chat",
        "utterance",
        "q",
        "msg",
        "body",
        "say",
      ],
      (v) => typeof v === "string" && v.trim().length > 0 && v.length < 20_000,
    );
    if (promptPath) {
      if (SECONDARY_PATH_RE.test(endpointUrl.pathname) && !respAnalysis.recognized) {
        return {
          accepted: false,
          kind: "secondary",
          cleanEndpoint,
          message: "Skipped a site account/settings call — not the AI chat endpoint. Still listening.",
          actionTip: "Send 1 message in the chat tab.",
        };
      }
      messagesPath = promptPath;
      inputMode = "prompt";
    }
  }

  // Permissive fallback: accept non-standard/custom prompt keys on non-secondary endpoints
  if (!messagesPath && !SECONDARY_PATH_RE.test(endpointUrl.pathname)) {
    const custom = findCustomPromptPath(body);
    if (custom && (respAnalysis.recognized || payload.looksLikeChat || custom.score >= 12)) {
      messagesPath = custom.path;
      inputMode = "prompt";
    }
  }

  if (!messagesPath) {
    return {
      accepted: false,
      kind: "secondary",
      cleanEndpoint,
      message: SECONDARY_PATH_RE.test(endpointUrl.pathname)
        ? "Skipped an account/usage request. Still listening — send one message in the chat."
        : "Caught a POST call, but couldn't find your chat message inside it (likely a helper request). Send 1 more message in the chat.",
      actionTip: "Still listening — send 1 real message, or paste Copy as cURL in Manual Paste Fallback.",
    };
  }

  // 6. Infer model, stream, thinking, deepSearch fields anywhere up to depth 4
  const modelPath = findPath(
    body,
    [
      "modelId",
      "model",
      "model_id",
      "modelName",
      "model_name",
      "modelSlug",
      "model_slug",
      "modelKey",
      "model_key",
      "engine",
      "assistant_id",
      "assistantId",
      "bot",
      "botId",
      "bot_id",
      "llm",
    ],
    (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 100,
  );
  const streamPath = findPath(
    body,
    ["stream", "streaming", "isStream", "is_stream", "useStream", "use_stream", "sse"],
    (v) => typeof v === "boolean",
  );
  const thinkingPath = findPath(
    body,
    [
      "thinking",
      "enable_thinking",
      "enableThinking",
      "deepThink",
      "deep_think",
      "reasoning",
      "extended_thinking",
      "extendedThinking",
      "think",
      "useThinking",
      "use_thinking",
    ],
    (v) => typeof v === "boolean",
  );
  const deepSearchPath = findPath(
    body,
    [
      "deepSearch",
      "deep_search",
      "webSearch",
      "web_search",
      "useSearch",
      "use_search",
      "enableSearch",
      "enable_search",
      "search",
      "online",
      "grounding",
      "internet",
      "web",
    ],
    (v) => typeof v === "boolean",
  );

  // Merge captured model with static-discovered models and sample metadata
  const rawBodyModel = modelPath ? getPath(body, modelPath) : undefined;
  const primaryModels: string[] = [];
  if (typeof rawBodyModel === "string" && rawBodyModel.trim()) {
    primaryModels.push(rawBodyModel.trim());
  } else if (respAnalysis.discoveredModel) {
    primaryModels.push(respAnalysis.discoveredModel);
  }
  const models = mergeModels(primaryModels, [
    ...preDiscoveredModels,
    ...extractModelsFromSample(sample),
  ]);

  // Scrub user's private chat prompt out of the stored template
  const template = structuredClone(body);
  clearAtPath(template, messagesPath, inputMode === "prompt" ? "" : []);
  if (thinkingPath) clearAtPath(template, thinkingPath, false);
  if (deepSearchPath) clearAtPath(template, deepSearchPath, false);
  if (streamPath) clearAtPath(template, streamPath, respAnalysis.format !== "json");

  // Preserve the correct Content-Type for the detected body format
  const finalHeaders = { ...headers };
  const hasCT = Object.keys(finalHeaders).some((k) => k.toLowerCase() === "content-type");
  if (bodyFormat === "multipart") {
    // Strip boundary-pinned multipart header so fetch automatically builds a fresh boundary on replay.
    for (const k of Object.keys(finalHeaders)) {
      if (k.toLowerCase() === "content-type") delete finalHeaders[k];
    }
  } else if (!hasCT) {
    finalHeaders["Content-Type"] =
      bodyFormat === "urlencoded"
        ? "application/x-www-form-urlencoded"
        : bodyFormat === "text"
          ? "text/plain;charset=UTF-8"
          : "application/json";
  }

  const schema: AdapterSchema = {
    messages: messagesPath,
    model: modelPath || [],
    stream: streamPath,
    thinking: thinkingPath,
    deepSearch: deepSearchPath,
    inputMode,
    bodyFormat,
    responseFormat: respAnalysis.format,
    ...(respAnalysis.customTextPath ? { responseTextPath: respAnalysis.customTextPath } : {}),
  };

  const schemaFields = [
    messagesPath.join("."),
    ...(modelPath ? [modelPath.join(".")] : []),
    ...(streamPath ? [streamPath.join(".")] : []),
    ...(thinkingPath ? [thinkingPath.join(".")] : []),
    ...(deepSearchPath ? [deepSearchPath.join(".")] : []),
    ...(bodyFormat !== "json" ? [`encoding:${bodyFormat}`] : []),
  ];

  const adapter: Adapter = {
    id: "",
    name: info.displayName,
    siteUrl: info.siteUrl,
    endpoint: endpointUrl.toString(),
    method: "POST",
    origin: info.origin,
    referer: info.referer,
    enabled: true,
    source: "captured",
    createdAt: new Date().toISOString(),
    verifiedAt: null,
    headers: finalHeaders,
    requestTemplate: template,
    schema,
    models,
  };

  return {
    accepted: true,
    adapter,
    transport,
    bodyFormat,
    inferredFormat: respAnalysis.format,
    schemaFields,
    cleanEndpoint,
  };
}

// ---------------------------------------------------------------------------
// Manual Paste Parser: accepts copy(__proxyCapture.last), copy(__proxyCapture.all),
// raw Copy as cURL (bash/macOS/Linux/cmd), AND raw Copy as fetch(...) calls!
// Purely parses — never evaluates pasted code.
// ---------------------------------------------------------------------------

function shellWords(input: string): string[] {
  // Handle both POSIX backslash line continuations and Windows cmd `^` continuations
  const src = input.replace(/\^\r?\n/g, " ").replace(/\\\r?\n/g, " ");
  const out: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote === "'") {
      if (c === "'") quote = "";
      else word += c;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = "";
      else if (c === "\\" && i + 1 < src.length && /[\\"$`nrt]/.test(src[i + 1])) {
        const next = src[++i];
        word += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
      } else {
        word += c;
      }
      started = true;
      continue;
    }
    // Support bash ANSI-C quoting $'...'
    if (c === "$" && src[i + 1] === "'") {
      i += 2;
      started = true;
      while (i < src.length && src[i] !== "'") {
        if (src[i] === "\\" && i + 1 < src.length) {
          const n = src[++i];
          word += n === "n" ? "\n" : n === "r" ? "\r" : n === "t" ? "\t" : n;
        } else {
          word += src[i];
        }
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < src.length) {
      word += src[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        out.push(word);
        word = "";
        started = false;
      }
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) throw new Error("Your pasted cURL has an unclosed quote. Re-copy the full command from DevTools and try again.");
  if (started) out.push(word);
  return out;
}

function readBalanced(src: string, start: number): string {
  const opener = src[start];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : ")";
  let depth = 0;
  let quote = "";
  let escape = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === opener) depth++;
    if (c === closer && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error("Could not find the end of the pasted request object. Re-copy the full request and paste again.");
}

function scoreCandidate(p: CapturedPayload): number {
  let s = 0;
  if (p.looksLikeChat) s += 100;
  if (p.url && !TELEMETRY_URL_RE.test(p.url) && !STATIC_ASSET_RE.test(p.url)) s += 50;
  else return -100;
  if (String(p.method || "POST").toUpperCase() === "POST") s += 20;
  if (p.transport === "eventsource" || p.transport === "websocket") s += 30;
  if ((p.responseContentType || "").toLowerCase().includes("event-stream")) s += 40;
  if (p.requestBody && typeof p.requestBody === "object") s += 25;
  if (p.responseSample && p.responseSample.length > 0) s += 15;
  return s;
}

export function pickBestCapturedPayload(list: unknown[]): CapturedPayload | null {
  const valid = list.filter(
    (item): item is CapturedPayload =>
      Boolean(item) &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as Record<string, unknown>).url === "string",
  );
  if (!valid.length) return null;
  let best: CapturedPayload | null = null;
  let bestScore = -Infinity;
  // Prefer later captures when scores tie (the user's most recent send)
  for (const item of valid) {
    const sc = scoreCandidate(item);
    if (sc >= bestScore) {
      bestScore = sc;
      best = item;
    }
  }
  return bestScore > 0 ? best : valid[valid.length - 1];
}

function parseCurlToPayload(input: string): CapturedPayload {
  const args = shellWords(input);
  let url = "";
  let explicitMethod = "";
  let forceGet = false;
  const headers: Record<string, string> = {};
  const dataParts: string[] = [];
  const urlencodedParts: string[] = [];
  const formParts: Record<string, unknown> = {};
  let hasForm = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-H" || arg === "--header") {
      const line = args[++i] || "";
      const at = line.indexOf(":");
      if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    } else if (arg.startsWith("--header=")) {
      const line = arg.slice(9);
      const at = line.indexOf(":");
      if (at > 0) headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    } else if (
      arg === "-d" ||
      arg === "--data" ||
      arg === "--data-raw" ||
      arg === "--data-binary" ||
      arg === "--data-ascii"
    ) {
      dataParts.push(args[++i] || "");
    } else if (/^--data(?:-raw|-binary|-ascii)?=/.test(arg)) {
      dataParts.push(arg.slice(arg.indexOf("=") + 1));
    } else if (arg === "--data-urlencode") {
      urlencodedParts.push(args[++i] || "");
    } else if (arg.startsWith("--data-urlencode=")) {
      urlencodedParts.push(arg.slice(17));
    } else if (arg === "-F" || arg === "--form" || arg === "--form-string") {
      const line = args[++i] || "";
      const eq = line.indexOf("=");
      if (eq > 0) {
        hasForm = true;
        const k = line.slice(0, eq).trim();
        const v = line.slice(eq + 1);
        try {
          formParts[k] = v.trim().startsWith("{") || v.trim().startsWith("[") ? JSON.parse(v) : v;
        } catch {
          formParts[k] = v;
        }
      }
    } else if (arg === "-b" || arg === "--cookie") {
      headers.Cookie = args[++i] || "";
    } else if (arg.startsWith("--cookie=")) {
      headers.Cookie = arg.slice(9);
    } else if (arg === "-A" || arg === "--user-agent") {
      headers["User-Agent"] = args[++i] || "";
    } else if (arg === "-e" || arg === "--referer") {
      headers.Referer = args[++i] || "";
    } else if (arg === "-G" || arg === "--get") {
      forceGet = true;
    } else if (arg === "-X" || arg === "--request") {
      explicitMethod = (args[++i] || "").toUpperCase();
    } else if (arg.startsWith("--request=")) {
      explicitMethod = arg.slice(10).toUpperCase();
    } else if (arg === "--url") {
      url = args[++i] || "";
    } else if (/^(?:https?|wss?):\/\//i.test(arg)) {
      url = arg;
    }
  }

  if (!url) {
    throw new Error("No website URL found inside the pasted cURL command. Make sure you copied the complete request.");
  }

  const rawData = dataParts.join("&");
  if (rawData.startsWith("@")) {
    throw new Error("That cURL references a local file (@file). Use DevTools → Copy as cURL to include the JSON body inline.");
  }

  if (forceGet && (rawData || urlencodedParts.length)) {
    const u = new URL(url);
    const sp = new URLSearchParams([...dataParts, ...urlencodedParts].join("&"));
    sp.forEach((v, k) => u.searchParams.set(k, v));
    url = u.toString();
  }

  const hasBody = !forceGet && (hasForm || dataParts.length > 0 || urlencodedParts.length > 0);
  const method = forceGet ? "GET" : explicitMethod || (hasBody ? "POST" : "GET");

  let bodyFormat: BodyFormat = "json";
  let requestBody: unknown = null;

  if (hasForm) {
    bodyFormat = "multipart";
    requestBody = formParts;
  } else if (urlencodedParts.length > 0 && dataParts.length === 0) {
    bodyFormat = "urlencoded";
    requestBody = urlencodedParts.join("&");
  } else if (hasBody) {
    const reqCT =
      Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] || "";
    const decoded = tryDecodeBody(rawData, undefined, reqCT);
    bodyFormat = decoded.bodyFormat;
    requestBody = decoded.body ?? rawData;
  }

  const origin = Object.entries(headers).find(([k]) => k.toLowerCase() === "origin")?.[1];
  const referer = Object.entries(headers).find(([k]) => k.toLowerCase() === "referer")?.[1];

  return {
    transport: "fetch",
    url,
    method,
    headers,
    bodyFormat,
    requestBody,
    pageOrigin: origin,
    pageUrl: referer,
    looksLikeChat: true,
  };
}

function parseFetchToPayload(input: string): CapturedPayload {
  const match = input.match(/\bfetch\s*\(\s*(['"`])((?:https?|wss?):\/\/[\s\S]*?)\1/);
  if (!match) {
    throw new Error("The fetch(...) call needs a complete quoted URL (e.g. fetch(\"https://...\")).");
  }
  const url = match[2];
  const headers: Record<string, string> = {};

  const hdrMatch = /\bheaders\s*:\s*/.exec(input);
  if (hdrMatch) {
    const start = input.indexOf("{", hdrMatch.index + hdrMatch[0].length);
    if (start >= 0) {
      try {
        const parsed = JSON5.parse(readBalanced(input, start));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === "string") headers[k] = v;
          }
        }
      } catch {
        throw new Error("Could not read the headers inside the fetch(...) snippet. Try Copy as cURL instead.");
      }
    }
  }

  const refMatch = /\breferrer\s*:\s*(['"])(https?:\/\/[^'"]+)\1/.exec(input);
  if (refMatch && !Object.keys(headers).some((k) => k.toLowerCase() === "referer")) {
    headers.Referer = refMatch[2];
  }

  const methodMatch = /\bmethod\s*:\s*(['"])([A-Za-z]+)\1/.exec(input);
  const bodyMatch = /\bbody\s*:\s*/.exec(input);
  let requestBody: unknown = null;
  let bodyFormat: BodyFormat = "json";

  if (bodyMatch) {
    const after = input.slice(bodyMatch.index + bodyMatch[0].length).trimStart();
    if (!after.startsWith("null") && !after.startsWith("undefined")) {
      const reqCT =
        Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] || "";
      if (/^JSON\.stringify\s*\(/.test(after)) {
        const open = after.indexOf("(");
        const inner = readBalanced(after, open).slice(1, -1);
        const parsed = JSON5.parse(inner);
        requestBody = parsed;
        bodyFormat = reqCT.toLowerCase().includes("text/plain") ? "text" : "json";
      } else if (/^new\s+URLSearchParams\s*\(/.test(after)) {
        const open = after.indexOf("(");
        const inner = readBalanced(after, open).slice(1, -1).trim();
        const parsed = JSON5.parse(inner);
        const decoded = tryDecodeBody(parsed, "urlencoded", "application/x-www-form-urlencoded");
        requestBody = decoded.body ?? parsed;
        bodyFormat = "urlencoded";
      } else if (after.startsWith("{")) {
        requestBody = JSON5.parse(readBalanced(after, 0));
        bodyFormat = reqCT.toLowerCase().includes("text/plain") ? "text" : "json";
      } else if (after[0] === "'" || after[0] === '"') {
        const q = after[0];
        let end = 1;
        let esc = false;
        for (; end < after.length; end++) {
          if (esc) esc = false;
          else if (after[end] === "\\") esc = true;
          else if (after[end] === q) break;
        }
        const literal = JSON5.parse(after.slice(0, end + 1));
        if (typeof literal === "string") {
          const decoded = tryDecodeBody(literal, undefined, reqCT);
          requestBody = decoded.body ?? literal;
          bodyFormat = decoded.bodyFormat;
        }
      } else {
        throw new Error(
          "Your fetch(...) body uses JavaScript variables that can't be pasted directly. Right-click the request in DevTools → Network and pick Copy as cURL (or Copy as fetch).",
        );
      }
    }
  }

  const method = methodMatch
    ? methodMatch[2].toUpperCase()
    : requestBody !== null
      ? "POST"
      : "GET";
  const origin = Object.entries(headers).find(([k]) => k.toLowerCase() === "origin")?.[1];

  return {
    transport: "fetch",
    url,
    method,
    headers,
    bodyFormat,
    requestBody,
    pageOrigin: origin || (refMatch ? new URL(refMatch[2]).origin : undefined),
    pageUrl: refMatch ? refMatch[2] : undefined,
    looksLikeChat: true,
  };
}

/**
 * Parse ANY manual fallback paste:
 *  - JSON copied from `copy(__proxyCapture.last)`
 *  - JSON array copied from `copy(__proxyCapture.all)`
 *  - Raw `curl ...` from DevTools "Copy as cURL"
 *  - Raw `fetch(...)` from DevTools "Copy as fetch"
 */
export function parseManualCaptureInput(rawInput: string): CapturedPayload {
  const text = rawInput.trim();
  if (!text) {
    throw new Error(
      "Paste the JSON from copy(__proxyCapture.last), or a Copy as cURL / Copy as fetch snippet.",
    );
  }
  if (/^curl(?:\.exe)?\b/i.test(text)) {
    return parseCurlToPayload(text);
  }
  if (/\bfetch\s*\(/.test(text)) {
    return parseFetchToPayload(text);
  }
  if (text.startsWith("{") || text.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      try {
        parsed = JSON5.parse(text);
      } catch {
        throw new Error(
          "That looks like JSON, but it may have been cut off. Run copy(__proxyCapture.last) again in Console and paste the complete result.",
        );
      }
    }
    if (Array.isArray(parsed)) {
      const picked = pickBestCapturedPayload(parsed);
      if (!picked) {
        throw new Error(
          "No chat requests were found inside that array yet. Send 1 message in the chat first, then run copy(__proxyCapture.last).",
        );
      }
      return picked;
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      // Handle user running copy(__proxyCapture) directly
      if (typeof obj.url !== "string" && obj.last && typeof obj.last === "object") {
        const last = obj.last as Record<string, unknown>;
        if (typeof last.url === "string") return last as unknown as CapturedPayload;
      }
      if (typeof obj.url !== "string" && Array.isArray(obj.all)) {
        const picked = pickBestCapturedPayload(obj.all);
        if (picked) return picked;
      }
      if (typeof obj.url === "string" && obj.url.trim()) {
        return obj as unknown as CapturedPayload;
      }
      throw new Error(
        "Missing endpoint URL in that pasted JSON. Run copy(__proxyCapture.last) after sending a chat message, or paste a Copy as cURL command.",
      );
    }
  }
  throw new Error(
    "Unrecognized format. Paste the JSON from copy(__proxyCapture.last), a Copy as cURL command, or a Copy as fetch(...) call.",
  );
}
