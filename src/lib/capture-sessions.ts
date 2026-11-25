import { randomBytes, randomUUID } from "node:crypto";
import { analyzeCapture, type CapturedPayload } from "@/lib/capture-analyzer";
import { buildCaptureArtifacts } from "@/lib/capture-script";
import { translateProbeError } from "@/lib/human-errors";
import { validateUrl } from "@/lib/network";
import { probeAdapter } from "@/lib/proxy";
import { uniqueId, updateDB } from "@/lib/store";
import {
  publicAdapter,
  type CaptureAnalysis,
  type CaptureEventPublic,
  type CaptureSessionPublic,
  type CaptureSessionStatus,
  type CaptureTransport,
  type Model,
  type PublicAdapter,
} from "@/lib/types";

const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 40;
const MAX_EVENTS = 30;

type InternalSession = {
  id: string;
  targetUrl: string;
  targetHost: string;
  reason: string;
  status: CaptureSessionStatus;
  createdAt: number;
  expiresAt: number;
  callbackUrl: string;
  consoleSnippet: string;
  bookmarklet: string;
  preDiscoveredModels: Model[];
  events: CaptureEventPublic[];
  adapter?: PublicAdapter;
  analysis?: CaptureAnalysis;
  lastMessage?: string;
  queue: Promise<unknown>;
};

const globalStore = globalThis as typeof globalThis & {
  __proxyStudioCaptureSessions?: Map<string, InternalSession>;
};

function sessions(): Map<string, InternalSession> {
  if (!globalStore.__proxyStudioCaptureSessions) {
    globalStore.__proxyStudioCaptureSessions = new Map();
  }
  return globalStore.__proxyStudioCaptureSessions;
}

export const CAPTURE_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Allow-Private-Network": "true",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin, Access-Control-Request-Private-Network",
};

function prune() {
  const map = sessions();
  const now = Date.now();
  for (const [id, session] of map) {
    if (now > session.expiresAt + 5 * 60 * 1000) {
      map.delete(id);
    }
  }
  while (map.size >= MAX_SESSIONS) {
    const oldest = map.keys().next().value;
    if (!oldest) break;
    map.delete(oldest);
  }
}

export function resolveCallbackOrigin(request: Request, explicit?: unknown): string {
  if (typeof explicit === "string" && explicit.trim()) {
    try {
      const parsed = new URL(explicit.trim());
      if (/^https?:$/.test(parsed.protocol)) {
        if (parsed.hostname === "0.0.0.0") {
          return `${parsed.protocol}//localhost${parsed.port ? `:${parsed.port}` : ""}`;
        }
        return parsed.origin;
      }
    } catch {
      /* fall through */
    }
  }
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim();
  let reqProto = "http";
  try {
    reqProto = new URL(request.url).protocol.replace(":", "") || "http";
  } catch {
    reqProto = "http";
  }
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    (host && /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?$/i.test(host) ? "http" : reqProto);
  if (host) {
    const normalized = host.replace(/^0\.0\.0\.0(?=:|$)/, "localhost");
    return `${proto}://${normalized}`;
  }
  const port = process.env.PORT || "8088";
  return `http://localhost:${port}`;
}

function toPublic(session: InternalSession): CaptureSessionPublic {
  const expired = session.status !== "completed" && Date.now() > session.expiresAt;
  const status: CaptureSessionStatus = expired ? "expired" : session.status;
  return {
    id: session.id,
    targetUrl: session.targetUrl,
    targetHost: session.targetHost,
    reason: session.reason,
    status,
    mode: "local",
    createdAt: new Date(session.createdAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    callbackUrl: session.callbackUrl,
    consoleSnippet: session.consoleSnippet,
    bookmarklet: session.bookmarklet,
    events: session.events,
    ...(session.adapter ? { adapter: session.adapter } : {}),
    ...(session.analysis ? { analysis: session.analysis } : {}),
    ...(session.lastMessage ? { lastMessage: session.lastMessage } : {}),
    preDiscoveredModelsCount: session.preDiscoveredModels.length,
  };
}

function pushEvent(
  session: InternalSession,
  event: Omit<CaptureEventPublic, "id" | "at">,
): CaptureEventPublic {
  const full: CaptureEventPublic = {
    id: randomUUID(),
    at: new Date().toISOString(),
    ...event,
  };
  session.events.unshift(full);
  if (session.events.length > MAX_EVENTS) session.events.length = MAX_EVENTS;
  session.lastMessage = full.message;
  return full;
}

export function createCaptureSession(opts: {
  targetUrl: string;
  callbackOrigin: string;
  reason?: string;
  preDiscoveredModels?: Model[];
}): CaptureSessionPublic {
  prune();
  const id = randomBytes(16).toString("base64url");
  const now = Date.now();
  let targetHost = opts.targetUrl;
  let normalizedUrl = opts.targetUrl;
  try {
    const u = new URL(opts.targetUrl);
    targetHost = u.hostname;
    normalizedUrl = u.toString();
  } catch {
    targetHost = opts.targetUrl.slice(0, 80);
  }
  const artifacts = buildCaptureArtifacts(opts.callbackOrigin, id);
  const session: InternalSession = {
    id,
    targetUrl: normalizedUrl,
    targetHost,
    reason:
      opts.reason ||
      "We couldn't connect automatically from public files alone (this usually means the site uses login, protection, or dynamic chat requests). Follow the 4 quick steps below to connect it directly from your browser.",
    status: "listening",
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    callbackUrl: artifacts.callbackUrl,
    consoleSnippet: artifacts.consoleSnippet,
    bookmarklet: artifacts.bookmarklet,
    preDiscoveredModels: (opts.preDiscoveredModels || []).slice(0, 80),
    events: [],
    queue: Promise.resolve(),
  };
  sessions().set(id, session);
  return toPublic(session);
}

export function getCaptureSession(id: string): CaptureSessionPublic | null {
  const session = sessions().get(id);
  if (!session) return null;
  return toPublic(session);
}

export function closeCaptureSession(id: string): boolean {
  return sessions().delete(id);
}

export type IngestResult = {
  httpStatus: number;
  body: Record<string, unknown>;
};

function normalizeTransport(raw?: string, url?: string): CaptureTransport {
  if (url && /^wss?:/i.test(url)) return "websocket";
  if (raw === "xhr" || raw === "eventsource" || raw === "websocket") return raw;
  return "fetch";
}

async function processIngest(
  session: InternalSession,
  payload: CapturedPayload,
): Promise<IngestResult> {
  if (session.status === "completed") {
    return {
      httpStatus: 200,
      body: {
        ok: true,
        status: "completed",
        alreadyCompleted: true,
        matched: true,
        message: "Great news — this site was already verified and saved.",
        adapter: session.adapter,
        analysis: session.analysis,
      },
    };
  }
  if (Date.now() > session.expiresAt) {
    session.status = "expired";
    return {
      httpStatus: 410,
      body: {
        ok: false,
        status: "expired",
        error: "This capture session expired after 15 minutes. Click 'Start new capture session' in Proxy Studio to try again.",
      },
    };
  }

  const transport = normalizeTransport(payload.transport, payload.url);
  const method = transport === "websocket" ? "WS" : String(payload.method || "POST").toUpperCase();

  const outcome = analyzeCapture(payload, session.targetUrl, session.preDiscoveredModels);

  if (!outcome.accepted) {
    const event = pushEvent(session, {
      transport,
      method,
      endpoint: outcome.cleanEndpoint,
      status:
        typeof payload.responseStatus === "number" && payload.responseStatus > 0
          ? payload.responseStatus
          : undefined,
      kind: outcome.kind,
      errorCode: outcome.kind,
      message: outcome.message,
      actionTip: outcome.actionTip,
    });
    return {
      httpStatus: 200,
      body: {
        ok: true,
        status: "listening",
        matched: false,
        kind: outcome.kind,
        message: outcome.message,
        actionTip: outcome.actionTip,
        event,
      },
    };
  }

  // Validate captured endpoint URL (allows ws/wss alongside http/https while blocking private hosts by default)
  try {
    await validateUrl(outcome.adapter.endpoint, transport === "websocket");
  } catch (err) {
    const friendly = translateProbeError({
      rawMessage: err instanceof Error ? err.message : "blocked",
      transport,
    });
    const event = pushEvent(session, {
      transport,
      method,
      endpoint: outcome.cleanEndpoint,
      kind: "probe_failed",
      errorCode: friendly.code,
      message: friendly.message,
      actionTip: friendly.actionTip,
    });
    return {
      httpStatus: 400,
      body: {
        ok: false,
        status: "listening",
        matched: false,
        kind: "probe_failed",
        errorCode: friendly.code,
        error: friendly.message,
        message: friendly.message,
        actionTip: friendly.actionTip,
        event,
      },
    };
  }

  // Run independent live server-side verification replay
  session.status = "probing";
  let probe;
  try {
    probe = await probeAdapter(outcome.adapter);
  } finally {
    if (session.status === "probing") session.status = "listening";
  }

  if (!probe.ok) {
    const friendly = translateProbeError({
      statusCode: probe.statusCode,
      rawMessage: probe.message,
      timedOut: probe.timedOut,
      transport,
    });
    const event = pushEvent(session, {
      transport,
      method,
      endpoint: outcome.cleanEndpoint,
      status: probe.statusCode,
      kind: "probe_failed",
      errorCode: friendly.code,
      latencyMs: probe.latencyMs,
      message: friendly.message,
      actionTip: friendly.actionTip,
    });
    return {
      httpStatus: 200,
      body: {
        ok: true,
        status: "listening",
        matched: false,
        kind: "probe_failed",
        errorCode: friendly.code,
        title: friendly.title,
        message: friendly.message,
        actionTip: friendly.actionTip,
        probe,
        event,
      },
    };
  }

  // Probe passed! Finalize adapter and save atomically to ./data/db.json
  const candidate = outcome.adapter;
  const finalFormat = probe.detectedFormat || outcome.inferredFormat;
  candidate.schema.responseFormat = finalFormat;
  candidate.verifiedAt = new Date().toISOString();

  if (
    probe.discoveredModel &&
    candidate.models.length === 1 &&
    candidate.models[0].id === "default" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(probe.discoveredModel)
  ) {
    candidate.models = [{ id: probe.discoveredModel, name: probe.discoveredModel }];
  } else if (
    probe.discoveredModel &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(probe.discoveredModel) &&
    candidate.schema.model.length === 0 &&
    !candidate.models.some((m) => m.id === probe.discoveredModel)
  ) {
    candidate.models.unshift({ id: probe.discoveredModel, name: probe.discoveredModel });
  }

  const saved = await updateDB((db) => {
    const existing = db.adapters.find(
      (a) => a.endpoint === candidate.endpoint && a.origin === candidate.origin,
    );
    if (existing) {
      existing.headers = candidate.headers;
      existing.referer = candidate.referer;
      existing.requestTemplate = candidate.requestTemplate;
      existing.schema = candidate.schema;
      existing.method = candidate.method;
      existing.verifiedAt = candidate.verifiedAt;
      existing.enabled = true;
      const seen = new Set(existing.models.map((m) => m.id));
      for (const m of candidate.models) {
        if (!seen.has(m.id)) {
          existing.models.push(m);
          seen.add(m.id);
        }
      }
      return existing;
    }
    candidate.id = uniqueId(candidate.name, db.adapters);
    db.adapters.push(candidate);
    return candidate;
  });

  const pub = publicAdapter(saved);
  const analysis: CaptureAnalysis = {
    endpoint: outcome.cleanEndpoint,
    method: saved.method || "POST",
    transport: outcome.transport,
    inputMode: saved.schema.inputMode || "messages",
    bodyFormat: outcome.bodyFormat,
    responseFormat: finalFormat,
    schemaFields: outcome.schemaFields,
    models: saved.models,
    headerNames: pub.headerNames,
    hasCredentials: pub.hasCredentials,
    latencyMs: probe.latencyMs,
    verified: true,
    ...(probe.sample ? { responsePreview: probe.sample } : {}),
  };

  const event = pushEvent(session, {
    transport: outcome.transport,
    method: saved.method || "POST",
    endpoint: outcome.cleanEndpoint,
    status: probe.statusCode || 200,
    kind: "verified",
    detectedFormat: finalFormat,
    latencyMs: probe.latencyMs,
    message: `Connected & verified "${saved.name}" (${finalFormat}, ${probe.latencyMs} ms, ${saved.models.length} model${saved.models.length === 1 ? "" : "s"}). Ready to use!`,
  });

  session.adapter = pub;
  session.analysis = analysis;
  session.status = "completed";

  return {
    httpStatus: 200,
    body: {
      ok: true,
      status: "completed",
      matched: true,
      message: event.message,
      adapter: pub,
      analysis,
      event,
    },
  };
}

export function ingestCapture(sessionId: string, payload: CapturedPayload): Promise<IngestResult> {
  const session = sessions().get(sessionId);
  if (!session) {
    return Promise.resolve({
      httpStatus: 404,
      body: {
        ok: false,
        error:
          "Capture session not found or expired. Open Live Browser Capture in Proxy Studio to start a fresh session.",
      },
    });
  }

  const next = session.queue.then(() => processIngest(session, payload));
  session.queue = next.catch(() => undefined);
  return next;
}
