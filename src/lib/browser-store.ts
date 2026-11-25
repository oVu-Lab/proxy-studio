import { analyzeCapture, parseManualCaptureInput } from "@/lib/capture-analyzer";
import { buildCaptureArtifacts } from "@/lib/capture-script";
import { extractText } from "@/lib/response-parser";
import {
  publicAdapter,
  type Adapter,
  type CaptureAnalysis,
  type CaptureEventPublic,
  type CaptureSessionPublic,
  type RequestLog,
} from "@/lib/types";

/**
 * Pure per-user browser-isolated persistence (`localStorage`) for Global Zero-Quota Mode.
 * Every visitor's adapters, auth headers/cookies, personal gateway URL, logs, and
 * Playground history live exclusively in their own browser — never written to any
 * shared database and burning zero Cloudflare Workers host quota.
 */

const KEYS = {
  adapters: "proxystudio.v1.adapters",
  logs: "proxystudio.v1.logs",
  settings: "proxystudio.v1.settings",
  playground: "proxystudio.v1.playground",
  modePref: "proxystudio.v1.mode",
} as const;

export type BrowserSettings = {
  /** User's own exported Cloudflare Worker or local proxy.mjs URL (e.g. https://my-proxy.workers.dev or http://127.0.0.1:8088) */
  personalGatewayUrl: string;
  /** Optional Bearer key for the user's personal exported gateway. */
  personalApiKey: string;
};

export type SavedTurn = { role: "user" | "assistant"; content: string };

const DEFAULT_SETTINGS: BrowserSettings = { personalGatewayUrl: "", personalApiKey: "" };

function safeRead<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function safeWrite(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore storage quota failure gracefully */
  }
}

export function loadModePreference(): "auto" | "local" | "global" {
  if (typeof window === "undefined") return "auto";
  try {
    const v = window.localStorage.getItem(KEYS.modePref);
    if (v === "local" || v === "global") return v;
  } catch { /* ignore */ }
  return "auto";
}

export function saveModePreference(mode: "auto" | "local" | "global") {
  if (typeof window === "undefined") return;
  try {
    if (mode === "auto") window.localStorage.removeItem(KEYS.modePref);
    else window.localStorage.setItem(KEYS.modePref, mode);
  } catch { /* ignore */ }
}

export function loadBrowserAdapters(): Adapter[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEYS.adapters);
    if (!raw) {
      const seed: Adapter[] = [];
      safeWrite(KEYS.adapters, seed);
      return seed;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as Adapter[];
  } catch { /* fallback to empty seed */ }
  const seed: Adapter[] = [];
  safeWrite(KEYS.adapters, seed);
  return seed;
}

export function saveBrowserAdapters(adapters: Adapter[]) {
  safeWrite(KEYS.adapters, adapters);
}

export function resetBrowserAdapters(): Adapter[] {
  const seed: Adapter[] = [];
  saveBrowserAdapters(seed);
  return seed;
}

export function loadBrowserLogs(): RequestLog[] {
  const logs = safeRead<RequestLog[]>(KEYS.logs, []);
  return Array.isArray(logs) ? logs.slice(0, 100) : [];
}

export function appendBrowserLog(entry: Omit<RequestLog, "id" | "at">): RequestLog[] {
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const next: RequestLog[] = [{ ...entry, id, at: new Date().toISOString() }, ...loadBrowserLogs()].slice(0, 100);
  safeWrite(KEYS.logs, next);
  return next;
}

export function clearBrowserLogs() {
  safeWrite(KEYS.logs, []);
}

export function loadBrowserSettings(): BrowserSettings {
  const s = safeRead<Partial<BrowserSettings>>(KEYS.settings, DEFAULT_SETTINGS);
  return {
    personalGatewayUrl: typeof s.personalGatewayUrl === "string" ? s.personalGatewayUrl : "",
    personalApiKey: typeof s.personalApiKey === "string" ? s.personalApiKey : "",
  };
}

export function saveBrowserSettings(next: BrowserSettings) {
  safeWrite(KEYS.settings, next);
}

export function loadPlaygroundHistory(): SavedTurn[] {
  const saved = safeRead<SavedTurn[]>(KEYS.playground, []);
  if (!Array.isArray(saved)) return [];
  return saved.filter(
    (t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string",
  ).slice(-40);
}

export function savePlaygroundHistory(turns: SavedTurn[]) {
  safeWrite(KEYS.playground, turns.slice(-40));
}

export function uniqueBrowserId(name: string, existing: Adapter[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "adapter";
  let id = base;
  let n = 2;
  while (existing.some((a) => a.id === id)) id = `${base}-${n++}`;
  return id;
}

export function upsertBrowserAdapter(incoming: Adapter): { adapters: Adapter[]; saved: Adapter } {
  const list = loadBrowserAdapters();
  const match = list.find(
    (a) => a.endpoint === incoming.endpoint && a.origin === incoming.origin,
  );
  if (match) {
    match.headers = incoming.headers;
    match.referer = incoming.referer;
    match.requestTemplate = incoming.requestTemplate;
    match.schema = incoming.schema;
    match.method = incoming.method;
    match.verifiedAt = incoming.verifiedAt || match.verifiedAt;
    match.enabled = true;
    const seen = new Set(match.models.map((m) => m.id));
    for (const m of incoming.models) {
      if (!seen.has(m.id)) {
        match.models.push(m);
        seen.add(m.id);
      }
    }
    saveBrowserAdapters(list);
    return { adapters: list, saved: match };
  }
  const copy: Adapter = { ...incoming, id: uniqueBrowserId(incoming.name, list) };
  list.push(copy);
  saveBrowserAdapters(list);
  return { adapters: list, saved: copy };
}

export function patchBrowserAdapter(
  id: string,
  patch: {
    name?: string;
    enabled?: boolean;
    endpoint?: string;
    origin?: string;
    referer?: string;
    models?: string[];
    headers?: Record<string, string>;
  },
): Adapter[] {
  const list = loadBrowserAdapters();
  const a = list.find((x) => x.id === id);
  if (!a) return list;
  if (typeof patch.name === "string" && patch.name.trim()) a.name = patch.name.trim().slice(0, 80);
  if (typeof patch.enabled === "boolean") a.enabled = patch.enabled;
  if (typeof patch.endpoint === "string" && patch.endpoint.trim()) a.endpoint = patch.endpoint.trim();
  if (typeof patch.origin === "string" && patch.origin.trim()) {
    try { a.origin = new URL(patch.origin.trim()).origin; } catch { a.origin = patch.origin.trim(); }
  }
  if (typeof patch.referer === "string" && patch.referer.trim()) a.referer = patch.referer.trim();
  if (Array.isArray(patch.models) && patch.models.length) {
    const clean = patch.models
      .filter((m) => /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(m))
      .slice(0, 100);
    if (clean.length) a.models = clean.map((m) => ({ id: m, name: m }));
  }
  if (patch.headers) a.headers = patch.headers;
  saveBrowserAdapters(list);
  return list;
}

export function deleteBrowserAdapter(id: string): Adapter[] {
  const next = loadBrowserAdapters().filter((a) => a.id !== id);
  saveBrowserAdapters(next);
  return next;
}

/** Build a pure zero-quota browser-side capture session (runs 100% locally in the visitor's browser). */
export function createBrowserCaptureSession(
  rawUrl: string,
  reason?: string,
): CaptureSessionPublic {
  let targetUrl = rawUrl.trim() || "https://example.com/";
  if (targetUrl && !/^https?:\/\//i.test(targetUrl)) targetUrl = `https://${targetUrl}`;
  let targetHost = "target site";
  try {
    const u = new URL(targetUrl);
    targetUrl = u.toString();
    targetHost = u.hostname;
  } catch {
    targetUrl = "https://example.com/";
  }
  const id = `local-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  // Pure client-side capture script (zero host Worker callback -> zero quota consumed!)
  const artifacts = buildCaptureArtifacts("", id, { manualOnly: true });
  return {
    id,
    targetUrl,
    targetHost,
    reason:
      reason ||
      "Global Mode runs 100% inside your browser with zero server calls. Run this capture script on the site, send 1 message, copy(__proxyCapture.last), and paste it into Manual Paste Fallback to save it privately to your browser — then export your own free Worker or Local Proxy!",
    status: "listening",
    mode: "global",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    callbackUrl: "",
    consoleSnippet: artifacts.consoleSnippet,
    bookmarklet: artifacts.bookmarklet,
    events: [],
    preDiscoveredModelsCount: 0,
  };
}

/** Analyze a pasted capture (`copy(__proxyCapture.last)`, `cURL`, or `fetch`) directly inside the browser and save to localStorage. */
export function ingestBrowserManualInput(
  rawInput: string,
  targetUrl: string,
  opts?: { name?: string; model?: string; source?: "captured" | "imported" },
):
  | {
      ok: true;
      adapter: Adapter;
      adapters: Adapter[];
      analysis: CaptureAnalysis;
      event: CaptureEventPublic;
    }
  | { ok: false; kind: "telemetry" | "secondary" | "error"; message: string; actionTip?: string } {
  let captured;
  try {
    captured = parseManualCaptureInput(rawInput);
  } catch (err) {
    return {
      ok: false,
      kind: "error",
      message:
        err instanceof Error
          ? err.message
          : "Paste copy(__proxyCapture.last) JSON, a Copy as cURL command, or Copy as fetch.",
    };
  }

  const outcome = analyzeCapture(captured, targetUrl || captured.pageUrl || captured.url);
  if (!outcome.accepted) {
    return {
      ok: false,
      kind: outcome.kind,
      message: outcome.message,
      actionTip: outcome.actionTip,
    };
  }

  const adapter = outcome.adapter;
  adapter.source = opts?.source || "captured";
  if (opts?.name?.trim()) adapter.name = opts.name.trim().slice(0, 80);
  if (opts?.model?.trim() && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(opts.model.trim())) {
    const mid = opts.model.trim();
    if (!adapter.models.some((m) => m.id === mid)) {
      adapter.models.unshift({ id: mid, name: mid });
    }
  }

  // Verify response preview from captured responseSample (browser cannot spoof Origin headers cross-origin)
  let preview = "";
  if (captured.responseSample) {
    const sample = captured.responseSample.trim();
    if (sample.startsWith("{")) {
      try {
        const hit = extractText(JSON.parse(sample), adapter.schema.responseTextPath);
        if (hit.matched) preview = (hit.content || hit.reasoning).slice(0, 140);
      } catch { /* ignore */ }
    } else if (/^data:\s*/m.test(sample)) {
      const parts: string[] = [];
      for (const line of sample.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (d.startsWith("{")) {
          try {
            const hit = extractText(JSON.parse(d), adapter.schema.responseTextPath);
            if (hit.content) parts.push(hit.content);
          } catch { /* ignore */ }
        }
      }
      preview = parts.join("").slice(0, 140);
    }
  }
  const hasGoodSample =
    Boolean(preview) ||
    (typeof captured.responseStatus === "number" &&
      captured.responseStatus >= 200 &&
      captured.responseStatus < 300);
  adapter.verifiedAt = hasGoodSample ? new Date().toISOString() : null;

  const { adapters, saved } = upsertBrowserAdapter(adapter);
  const pub = publicAdapter(saved);
  const analysis: CaptureAnalysis = {
    endpoint: outcome.cleanEndpoint,
    method: saved.method || "POST",
    transport: outcome.transport,
    inputMode: saved.schema.inputMode || "messages",
    bodyFormat: outcome.bodyFormat,
    responseFormat: outcome.inferredFormat,
    schemaFields: outcome.schemaFields,
    models: saved.models,
    headerNames: pub.headerNames,
    hasCredentials: pub.hasCredentials,
    latencyMs: 0,
    verified: Boolean(saved.verifiedAt),
    ...(preview ? { responsePreview: preview } : {}),
  };

  const event: CaptureEventPublic = {
    id: `${Date.now()}`,
    at: new Date().toISOString(),
    transport: outcome.transport,
    method: saved.method || "POST",
    endpoint: outcome.cleanEndpoint,
    status: captured.responseStatus || 200,
    kind: "verified",
    detectedFormat: outcome.inferredFormat,
    message: `Saved "${saved.name}" privately in your browser (${outcome.inferredFormat}, ${saved.models.length} model${saved.models.length === 1 ? "" : "s"}). Export your personal Worker or Local Proxy to start calling /v1!`,
  };

  return { ok: true, adapter: saved, adapters, analysis, event };
}
