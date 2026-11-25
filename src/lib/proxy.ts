import { safeFetch, validateUrl } from "@/lib/network";
import {
  extractStreamPayload,
  extractText,
  parseAnyStream,
  parseSSE,
  setPath,
} from "@/lib/response-parser";
import type { Adapter, ResponseFormat } from "@/lib/types";

export { extractStreamPayload, extractText, parseAnyStream, parseSSE };

export type Message = { role: string; content: string };

export function formatPromptString(messages: Message[]): string {
  if (messages.length === 1 && messages[0].role === "user") return messages[0].content;
  const nonEmpty = messages.filter((m) => m.content.trim());
  if (nonEmpty.length === 1) return nonEmpty[0].content;
  return nonEmpty
    .map((m) => {
      if (m.role === "system") return `System: ${m.content}`;
      if (m.role === "assistant") return `Assistant: ${m.content}`;
      return `User: ${m.content}`;
    })
    .join("\n\n");
}

function formatGeminiContents(messages: Message[]): {
  system?: string;
  contents: { role: string; parts: { text: string }[] }[];
} {
  const systemParts: string[] = [];
  const contents: { role: string; parts: { text: string }[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content.trim()) systemParts.push(m.content);
    } else {
      contents.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      });
    }
  }
  const system = systemParts.join("\n\n") || undefined;
  if (!contents.length && system) {
    contents.push({ role: "user", parts: [{ text: system }] });
    return { contents };
  }
  return { system, contents };
}

export function buildUpstreamBody(
  adapter: Adapter,
  model: string,
  messages: Message[],
  stream: boolean,
  thinking = false,
  search = false,
): Record<string, unknown> {
  const body = structuredClone(adapter.requestTemplate || {});
  const mode = adapter.schema.inputMode || "messages";

  if (mode === "prompt") {
    setPath(body, adapter.schema.messages, formatPromptString(messages));
  } else if (mode === "gemini") {
    const formatted = formatGeminiContents(messages);
    setPath(body, adapter.schema.messages, formatted.contents);
    if (formatted.system) {
      body.systemInstruction = { parts: [{ text: formatted.system }] };
    }
  } else {
    setPath(body, adapter.schema.messages, messages);
  }

  if (adapter.schema.model.length > 0 && model) {
    setPath(body, adapter.schema.model, model);
  }
  if (adapter.schema.stream && adapter.schema.stream.length > 0) {
    setPath(body, adapter.schema.stream, stream);
  }
  if (adapter.schema.thinking && adapter.schema.thinking.length > 0) {
    setPath(body, adapter.schema.thinking, thinking);
  }
  if (adapter.schema.deepSearch && adapter.schema.deepSearch.length > 0) {
    setPath(body, adapter.schema.deepSearch, search);
  }
  return body;
}

function serializeBody(
  adapter: Adapter,
  bodyObj: Record<string, unknown>,
  messages: Message[],
): { payload: BodyInit; defaultContentType?: string } {
  const format = adapter.schema.bodyFormat || "json";

  // Pure plain-text body (not JSON)
  if (
    format === "text" &&
    adapter.schema.messages.length === 1 &&
    adapter.schema.messages[0] === "__rawText"
  ) {
    return {
      payload: formatPromptString(messages),
      defaultContentType: "text/plain;charset=UTF-8",
    };
  }

  // FormData / multipart
  if (format === "multipart") {
    const fd = new FormData();
    for (const [k, v] of Object.entries(bodyObj)) {
      if (v === undefined || v === null) continue;
      if (typeof v === "string" && v.startsWith("[file:")) continue;
      fd.append(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    return { payload: fd };
  }

  // application/x-www-form-urlencoded (URLSearchParams)
  if (format === "urlencoded") {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(bodyObj)) {
      if (v === undefined || v === null) continue;
      sp.set(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    return {
      payload: sp.toString(),
      defaultContentType: "application/x-www-form-urlencoded",
    };
  }

  // text/plain JSON string (skips CORS preflight on some sites like Firebase / custom workers)
  if (format === "text") {
    return {
      payload: JSON.stringify(bodyObj),
      defaultContentType: "text/plain;charset=UTF-8",
    };
  }

  return {
    payload: JSON.stringify(bodyObj),
    defaultContentType: "application/json",
  };
}

export function upstreamHeaders(adapter: Adapter, defaultContentType?: string): Headers {
  const headers = new Headers();
  const isMultipart = adapter.schema.bodyFormat === "multipart";
  for (const [name, value] of Object.entries(adapter.headers)) {
    if (
      /^(host|content-length|connection|transfer-encoding|accept-encoding|origin|referer|sec-.*|:.*)$/i.test(
        name,
      )
    ) {
      continue;
    }
    if (isMultipart && name.toLowerCase() === "content-type") continue;
    headers.set(name, value);
  }
  if (defaultContentType && !isMultipart && !headers.has("content-type")) {
    headers.set("content-type", defaultContentType);
  }
  if (adapter.origin) headers.set("origin", adapter.origin);
  if (adapter.referer) headers.set("referer", adapter.referer);
  return headers;
}

/** Open a WebSocket chat call, send one prompt/JSON frame, and bridge replies as a text/event-stream Response. */
async function callWebSocketAdapter(
  adapter: Adapter,
  model: string,
  messages: Message[],
  thinking: boolean,
  search: boolean,
  signal?: AbortSignal,
  idleFinishMs = 1500,
): Promise<Response> {
  await validateUrl(adapter.endpoint, true);
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket replay is not available in this Node.js runtime.");
  }

  const outbound = adapter.schema.wsPlainText
    ? formatPromptString(messages)
    : JSON.stringify(buildUpstreamBody(adapter, model, messages, true, thinking, search));
  const customPath = adapter.schema.responseTextPath;

  return new Promise<Response>((resolve, reject) => {
    let opened = false;
    let settled = false;
    const ws = new WebSocket(adapter.endpoint);
    const openTimer = setTimeout(() => {
      if (!opened && !settled) {
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error("WebSocket connection timed out."));
      }
    }, 15_000);

    const onAbort = () => {
      clearTimeout(openTimer);
      try { ws.close(); } catch { /* ignore */ }
      if (!settled) { settled = true; reject(new Error("Request aborted.")); }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    ws.addEventListener("error", () => {
      clearTimeout(openTimer);
      if (!opened && !settled) {
        settled = true;
        reject(new Error("WebSocket connection rejected (may require login cookies or auth token)."));
      }
    });

    ws.addEventListener("open", () => {
      opened = true;
      clearTimeout(openTimer);
      try { ws.send(outbound); } catch (e) {
        settled = true;
        reject(e instanceof Error ? e : new Error("Failed to send WebSocket message."));
        return;
      }

      const encoder = new TextEncoder();
      let closed = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let maxTimer: ReturnType<typeof setTimeout> | null = null;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const finish = () => {
            if (closed) return;
            closed = true;
            if (idleTimer) clearTimeout(idleTimer);
            if (maxTimer) clearTimeout(maxTimer);
            try { controller.enqueue(encoder.encode("data: [DONE]\n\n")); } catch { /* ignore */ }
            try { controller.close(); } catch { /* ignore */ }
            try { ws.close(); } catch { /* ignore */ }
          };

          maxTimer = setTimeout(finish, 45_000);
          idleTimer = setTimeout(finish, 18_000);

          ws.addEventListener("message", (event) => {
            if (closed || typeof event.data !== "string") return;
            const raw = event.data.trim();
            if (!raw) return;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(finish, idleFinishMs);

            if (raw === "[DONE]" || raw === "DONE" || raw === "[END]") {
              finish();
              return;
            }
            if (raw.startsWith("{")) {
              try {
                const parsed = JSON.parse(raw) as Record<string, unknown>;
                const hit = extractText(parsed, customPath);
                if (hit.matched) {
                  if (hit.content || hit.reasoning) {
                    const frame = {
                      choices: [{
                        index: 0,
                        delta: {
                          ...(hit.content ? { content: hit.content } : {}),
                          ...(hit.reasoning ? { reasoning_content: hit.reasoning } : {}),
                        },
                        finish_reason: hit.finish,
                      }],
                      ...(hit.model ? { model: hit.model } : {}),
                      ...(hit.usage ? { usage: hit.usage } : {}),
                    };
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
                  }
                  if (hit.finish === "stop") finish();
                  return;
                }
              } catch { /* treat as plain text below */ }
            }
            // Plain text WebSocket frame fallback
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: event.data }, finish_reason: null }] })}\n\n`),
            );
          });

          ws.addEventListener("close", finish);
          ws.addEventListener("error", finish);
        },
        cancel() {
          closed = true;
          if (idleTimer) clearTimeout(idleTimer);
          if (maxTimer) clearTimeout(maxTimer);
          try { ws.close(); } catch { /* ignore */ }
        },
      });

      settled = true;
      resolve(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream; charset=utf-8", "X-Proxy-Transport": "websocket" },
        }),
      );
    });
  });
}

export async function callAdapter(
  adapter: Adapter,
  model: string,
  messages: Message[],
  stream: boolean,
  thinking = false,
  search = false,
  signal?: AbortSignal,
): Promise<Response> {
  // 1. WebSocket upstream
  if (adapter.method === "WS" || /^wss?:/i.test(adapter.endpoint)) {
    return callWebSocketAdapter(adapter, model, messages, thinking, search, signal);
  }

  // 2. GET / EventSource with query parameters
  if (adapter.method === "GET") {
    const target = new URL(adapter.endpoint);
    const param = adapter.schema.queryParam || adapter.schema.messages[0] || "prompt";
    target.searchParams.set(param, formatPromptString(messages));
    if (adapter.schema.model.length === 1 && model) {
      target.searchParams.set(adapter.schema.model[0], model);
    }
    if (adapter.schema.thinking?.length === 1) {
      target.searchParams.set(adapter.schema.thinking[0], String(thinking));
    }
    if (adapter.schema.deepSearch?.length === 1) {
      target.searchParams.set(adapter.schema.deepSearch[0], String(search));
    }
    const headers = upstreamHeaders(adapter);
    if (!headers.has("accept")) {
      headers.set(
        "accept",
        adapter.schema.responseFormat === "json" ? "application/json" : "text/event-stream, application/json",
      );
    }
    return safeFetch(target.toString(), { method: "GET", headers, signal }, 180_000);
  }

  // 3. POST with query parameter prompt (and empty body)
  if (adapter.schema.queryParam && Object.keys(adapter.requestTemplate || {}).length === 0) {
    const target = new URL(adapter.endpoint);
    target.searchParams.set(adapter.schema.queryParam, formatPromptString(messages));
    if (adapter.schema.model.length === 1 && model) {
      target.searchParams.set(adapter.schema.model[0], model);
    }
    return safeFetch(
      target.toString(),
      { method: "POST", headers: upstreamHeaders(adapter), signal },
      180_000,
    );
  }

  // 4. Standard POST across JSON, text/plain JSON, FormData multipart, and x-www-form-urlencoded
  const bodyObj = buildUpstreamBody(adapter, model, messages, stream, thinking, search);
  const { payload, defaultContentType } = serializeBody(adapter, bodyObj, messages);
  return safeFetch(
    adapter.endpoint,
    {
      method: "POST",
      headers: upstreamHeaders(adapter, defaultContentType),
      body: payload,
      signal,
    },
    180_000,
  );
}

export type ProbeResult = {
  ok: boolean;
  message: string;
  latencyMs: number;
  statusCode?: number;
  timedOut?: boolean;
  detectedFormat?: ResponseFormat;
  discoveredModel?: string;
  sample?: string;
};

async function runSingleProbe(
  adapter: Adapter,
  stream: boolean,
  signal: AbortSignal,
  start: number,
): Promise<ProbeResult> {
  const model = adapter.models[0]?.id || "default";
  const isWs = adapter.method === "WS" || /^wss?:/i.test(adapter.endpoint);
  const response = await callAdapter(
    adapter,
    model,
    [{ role: "user", content: "Reply with OK." }],
    stream,
    false,
    false,
    signal,
  );

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const authHint =
      response.status === 401 || response.status === 403
        ? "; it may require authentication, login cookies, or custom headers"
        : "";
    return {
      ok: false,
      statusCode: response.status,
      message: `Upstream returned HTTP ${response.status}${authHint}.`,
      latencyMs: Date.now() - start,
    };
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const isNdjson = contentType.includes("ndjson") || contentType.includes("jsonl");
  const isPlainJson =
    contentType.includes("application/json") ||
    (contentType.includes("json") && !contentType.includes("event-stream") && !isNdjson);

  if (isPlainJson) {
    const raw = await response.text();
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const extracted = extractText(
          parsed as Record<string, unknown>,
          adapter.schema.responseTextPath,
        );
        if (extracted.matched) {
          const preview = (extracted.content || extracted.reasoning).slice(0, 140).trim();
          return {
            ok: true,
            statusCode: response.status,
            detectedFormat: "json",
            discoveredModel: extracted.model,
            sample: preview || undefined,
            message: "Valid JSON chat response received.",
            latencyMs: Date.now() - start,
          };
        }
      }
    } catch {
      /* unrecognized json */
    }
    return {
      ok: false,
      statusCode: response.status,
      message: "Endpoint returned JSON, but no recognizable assistant reply field was found.",
      latencyMs: Date.now() - start,
    };
  }

  // Plain text non-SSE endpoint (e.g. text/plain returning answer directly)
  if (contentType.includes("text/plain") && !isWs) {
    const raw = (await response.text()).trim();
    if (raw && !raw.startsWith("<")) {
      // Check if mislabelled SSE/JSON inside text/plain
      if (/^data:\s*/m.test(raw)) {
        return {
          ok: true,
          statusCode: response.status,
          detectedFormat: "custom-sse",
          sample: raw.slice(0, 140),
          message: "Valid streaming chat response received (custom SSE).",
          latencyMs: Date.now() - start,
        };
      }
      if (raw.startsWith("{")) {
        try {
          const obj = JSON.parse(raw) as Record<string, unknown>;
          const hit = extractText(obj, adapter.schema.responseTextPath);
          if (hit.matched) {
            return {
              ok: true,
              statusCode: response.status,
              detectedFormat: "json",
              discoveredModel: hit.model,
              sample: (hit.content || hit.reasoning).slice(0, 140).trim() || undefined,
              message: "Valid JSON chat response received.",
              latencyMs: Date.now() - start,
            };
          }
        } catch { /* plain text */ }
      }
      return {
        ok: true,
        statusCode: response.status,
        detectedFormat: "custom-sse",
        sample: raw.slice(0, 140),
        message: "Valid plain-text chat response received.",
        latencyMs: Date.now() - start,
      };
    }
  }

  // Streaming response (SSE, NDJSON, Vercel AI stream, or WebSocket bridge)
  let sawFrames = 0;
  let sample = "";
  let discoveredModel: string | undefined;
  let detectedFormat: ResponseFormat | undefined = isWs ? "websocket" : undefined;

  for await (const { raw, isSse } of parseAnyStream(response.body)) {
    const parsed = extractStreamPayload(raw, adapter.schema.responseTextPath);
    if (parsed === "done") break;
    if (parsed && parsed.matched) {
      sawFrames++;
      if (!discoveredModel && parsed.model) discoveredModel = parsed.model;
      if (parsed.content) sample += parsed.content;
      else if (parsed.reasoning && !sample) sample += parsed.reasoning;
      if (!detectedFormat) {
        if (!isSse && (isNdjson || raw.trim().startsWith("{"))) {
          detectedFormat = "ndjson";
        } else if (parsed.format === "openai-sse") {
          detectedFormat = "openai-sse";
        } else if (parsed.format === "anthropic-sse") {
          detectedFormat = "anthropic-sse";
        } else {
          detectedFormat = "custom-sse";
        }
      }
      if (sample.trim().length > 0 || sawFrames >= 1) {
        const label =
          detectedFormat === "websocket"
            ? "WebSocket"
            : detectedFormat === "openai-sse"
              ? "OpenAI SSE"
              : detectedFormat === "anthropic-sse"
                ? "Anthropic SSE"
                : detectedFormat === "ndjson"
                  ? "NDJSON stream"
                  : "custom SSE";
        return {
          ok: true,
          statusCode: isWs ? 101 : response.status,
          detectedFormat,
          discoveredModel,
          sample: sample.slice(0, 140).trim() || undefined,
          message: `Valid chat response received (${label}).`,
          latencyMs: Date.now() - start,
        };
      }
    } else if (
      isSse &&
      raw.trim() &&
      !raw.trim().startsWith("{") &&
      raw.trim().length < 200 &&
      contentType.includes("event-stream")
    ) {
      return {
        ok: true,
        statusCode: response.status,
        detectedFormat: isWs ? "websocket" : "custom-sse",
        sample: raw.trim().slice(0, 140),
        message: "Valid plain-text SSE stream received.",
        latencyMs: Date.now() - start,
      };
    }
    if (sawFrames > 8) break;
  }

  return {
    ok: false,
    statusCode: isWs ? 0 : response.status,
    message: "The endpoint responded, but did not return a recognizable chat response.",
    latencyMs: Date.now() - start,
  };
}

export async function probeAdapter(adapter: Adapter): Promise<ProbeResult> {
  const start = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 25_000);
  try {
    const preferJson = adapter.schema.responseFormat === "json";
    const first = await runSingleProbe(adapter, !preferJson, abort.signal, start);
    if (first.ok) return first;

    if (
      !abort.signal.aborted &&
      adapter.method !== "GET" &&
      adapter.method !== "WS" &&
      adapter.schema.stream &&
      first.statusCode !== 401 &&
      first.statusCode !== 403 &&
      first.statusCode !== 404
    ) {
      const second = await runSingleProbe(adapter, preferJson, abort.signal, start);
      if (second.ok) return second;
    }
    return first;
  } catch (error) {
    const timedOut = abort.signal.aborted;
    return {
      ok: false,
      timedOut,
      message: timedOut
        ? "Probe timed out after 25 seconds."
        : error instanceof Error
          ? error.message
          : "Could not connect.",
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}
