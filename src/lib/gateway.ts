import { randomUUID, timingSafeEqual } from "node:crypto";
import { appendLog, readDB } from "@/lib/store";
import { callAdapter, extractStreamPayload, extractText, parseAnyStream, type Message } from "@/lib/proxy";
import type { Adapter } from "@/lib/types";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key",
  "Access-Control-Allow-Private-Network": "true",
};
export function options() { return new Response(null, { status: 204, headers: cors }); }
function json(data: unknown, status = 200, headers: Record<string, string> = {}) { return Response.json(data, { status, headers: { ...cors, ...headers } }); }
function error(message: string, status: number, code: string, type = "invalid_request_error") { return json({ error: { message, type, param: null, code } }, status); }

function isAuthorized(request: Request, localKey: string) {
  const expected = process.env.STUDIO_API_KEY || localKey;
  if (!expected) return true;
  const supplied = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || request.headers.get("x-api-key") || "";
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function listModels(request: Request, adapterId?: string) {
  const db = await readDB();
  if (!isAuthorized(request, db.settings.localApiKey)) return error("Invalid or missing local API key.", 401, "invalid_api_key", "authentication_error");
  const adapters = db.adapters.filter((a) => a.enabled && (!adapterId || a.id === adapterId));
  if (adapterId && !adapters.length) return error("Adapter not found or disabled.", 404, "adapter_not_found");
  const data = adapters.flatMap((adapter) => adapter.models.flatMap((model) => {
    const base = adapterId ? model.id : `${adapter.id}/${model.id}`;
    const variants = [base];
    if (adapter.schema.thinking) variants.push(`${base}-think`);
    if (adapter.schema.deepSearch) variants.push(`${base}-search`);
    if (adapter.schema.thinking && adapter.schema.deepSearch) variants.push(`${base}-think-search`);
    return variants.map((id) => ({ id, object: "model", created: Math.floor(Date.parse(adapter.createdAt) / 1000), owned_by: adapter.id }));
  }));
  return json({ object: "list", data });
}

function resolveModel(adapters: Adapter[], raw: string, scoped?: string) {
  let model = raw, thinking = false, search = false;
  // Suffixes may be supplied in either order.
  for (let i = 0; i < 2; i++) {
    if (model.endsWith("-think") && !thinking) { thinking = true; model = model.slice(0, -6); }
    else if (model.endsWith("-search") && !search) { search = true; model = model.slice(0, -7); }
    else break;
  }
  let candidates = adapters.filter((a) => a.enabled && (!scoped || a.id === scoped));
  if (!scoped) {
    const namespace = model.split("/")[0];
    const namespaced = candidates.find((a) => a.id === namespace);
    if (namespaced) { candidates = [namespaced]; model = model.slice(namespace.length + 1); }
  } else if (model.startsWith(`${scoped}/`)) model = model.slice(scoped.length + 1);
  const matches = candidates.filter((a) => a.models.some((m) => m.id === model));
  if (matches.length !== 1) return { error: matches.length ? "Model is ambiguous; use adapter-id/model-id." : `Model '${raw}' was not found on an enabled adapter.` };
  const adapter = matches[0];
  if (thinking && !adapter.schema.thinking) return { error: "This adapter does not expose a thinking flag." };
  if (search && !adapter.schema.deepSearch) return { error: "This adapter does not expose a deepSearch flag." };
  return { adapter, model, thinking, search };
}

export async function chat(request: Request, scoped?: string): Promise<Response> {
  const started = Date.now();
  const db = await readDB();
  if (!isAuthorized(request, db.settings.localApiKey)) return error("Invalid or missing local API key.", 401, "invalid_api_key", "authentication_error");
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 1_000_000) return error("Request body is too large.", 413, "request_too_large");
    body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch { return error("Request body must be a JSON object.", 400, "invalid_json"); }
  if (typeof body.model !== "string" || !body.model.trim()) return error("Provide a model from GET /v1/models.", 400, "invalid_model");
  if (!Array.isArray(body.messages) || !body.messages.length) return error("Provide a non-empty messages array.", 400, "invalid_messages");
  if (body.tools || body.functions || (body.n !== undefined && body.n !== 1)) return error("Tools, functions and multiple choices are not supported by this bridge.", 400, "unsupported_parameter");
  const messages: Message[] = [];
  for (const item of body.messages) {
    if (!item || typeof item !== "object") return error("Each message must have a role and text content.", 400, "invalid_messages");
    const m = item as Record<string, unknown>;
    const role = m.role === "developer" ? "system" : m.role;
    if (!["system", "user", "assistant"].includes(String(role))) return error("Only system, user and assistant messages are supported.", 400, "unsupported_message");
    let content: string;
    if (typeof m.content === "string") content = m.content;
    else if (Array.isArray(m.content) && m.content.every((p: unknown) => p && typeof p === "object" && (p as Record<string, unknown>).type === "text" && typeof (p as Record<string, unknown>).text === "string")) content = m.content.map((p: { text: string }) => p.text).join("\n");
    else return error("Only text messages are supported; images and tool calls are not passed through.", 400, "unsupported_message");
    messages.push({ role: String(role), content });
  }
  const resolved = resolveModel(db.adapters, body.model, scoped);
  if (resolved.error || !resolved.adapter || !resolved.model) return error(resolved.error || "Model not found.", 404, "model_not_found");
  const { adapter, model, thinking, search } = resolved;
  const stream = body.stream === true;
  const customTextPath = adapter.schema.responseTextPath;
  const formatHint = adapter.schema.responseFormat;

  const log = async (status: number, message?: string) => {
    try { await appendLog({ adapterId: adapter.id, adapterName: adapter.name, model: body.model as string, status, durationMs: Date.now() - started, stream, ...(message ? { error: message.slice(0, 180) } : {}) }); } catch (e) { console.error("Could not save local request log", e); }
  };

  let response: Response;
  try { response = await callAdapter(adapter, model, messages, stream, thinking, search, request.signal); }
  catch (e) { await log(502, "Could not reach upstream"); return error(e instanceof Error ? e.message : "Could not reach upstream.", 502, "upstream_unavailable", "api_error"); }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    await log(response.status, `Upstream HTTP ${response.status}`);
    return error(`Upstream returned HTTP ${response.status}. Check the adapter authentication and endpoint.`, response.status >= 400 && response.status < 600 ? response.status : 502, "upstream_error", "api_error");
  }

  const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`, created = Math.floor(Date.now() / 1000), outputModel = body.model;
  const type = (response.headers.get("content-type") || "").toLowerCase();
  const isNdjson = type.includes("ndjson") || type.includes("jsonl");
  const isJson = type.includes("json") && !type.includes("event-stream") && !isNdjson;
  const isPlainText = type.includes("text/plain") && !type.includes("event-stream");
  const isPlainSse = type.includes("event-stream");
  const usageRequested = !!(body.stream_options && typeof body.stream_options === "object" && (body.stream_options as Record<string, unknown>).include_usage);

  const parsePlainText = (rawText: string) => {
    const t = rawText.trim();
    if (t.startsWith("{")) {
      try {
        const p = extractText(JSON.parse(t) as Record<string, unknown>, customTextPath);
        if (p.matched) return p;
      } catch { /* fall back to plain string */ }
    }
    if (/^data:\s*/m.test(t)) {
      let acc = "", rsn = "";
      for (const line of t.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const p = extractStreamPayload(line.slice(5).trim(), customTextPath);
        if (p === "done") break;
        if (p) { acc += p.content; rsn += p.reasoning; }
        else { const v = line.slice(5).trim(); if (v && !v.startsWith("{")) acc += v; }
      }
      return { content: acc, reasoning: rsn, finish: "stop" as string | null, usage: undefined };
    }
    return { content: rawText, reasoning: "", finish: "stop" as string | null, usage: undefined };
  };

  if (!stream) {
    try {
      let content = "", reasoning = "", finish: string | null = null, usage: unknown;
      if (isJson) {
        const parsed = extractText(await response.json() as Record<string, unknown>, customTextPath);
        content = parsed.content; reasoning = parsed.reasoning; finish = parsed.finish; usage = parsed.usage;
      } else if (isPlainText) {
        const parsed = parsePlainText(await response.text());
        content = parsed.content; reasoning = parsed.reasoning; finish = parsed.finish; usage = parsed.usage;
      } else {
        for await (const { raw, isSse } of parseAnyStream(response.body, formatHint)) {
          const parsed = extractStreamPayload(raw, customTextPath);
          if (parsed === "done") break;
          if (parsed) {
            content += parsed.content; reasoning += parsed.reasoning;
            finish = parsed.finish || finish; usage = parsed.usage || usage;
          } else if (isSse && isPlainSse && raw && !raw.trim().startsWith("{")) {
            content += raw;
          }
        }
      }
      await log(200);
      return json({
        id, object: "chat.completion", created, model: outputModel,
        choices: [{ index: 0, message: { role: "assistant", content, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: finish || "stop", logprobs: null }],
        ...(usage ? { usage } : {}),
      });
    } catch { await log(502, "Could not read upstream response"); return error("Could not read the upstream response.", 502, "upstream_response_error", "api_error"); }
  }

  const encoder = new TextEncoder();
  let cancelled = false;
  const result = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (data: unknown) => { if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); };
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id, object: "chat.completion.chunk", created, model: outputModel, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] });
      let finish: string | null = null, usage: unknown;
      try {
        send(chunk({ role: "assistant" }));
        if (isJson) {
          const parsed = extractText(await response.json() as Record<string, unknown>, customTextPath);
          if (parsed.reasoning) send(chunk({ reasoning_content: parsed.reasoning }));
          if (parsed.content) send(chunk({ content: parsed.content }));
          finish = parsed.finish; usage = parsed.usage;
        } else if (isPlainText) {
          const parsed = parsePlainText(await response.text());
          if (parsed.reasoning) send(chunk({ reasoning_content: parsed.reasoning }));
          if (parsed.content) send(chunk({ content: parsed.content }));
          finish = parsed.finish; usage = parsed.usage;
        } else {
          for await (const { raw, isSse } of parseAnyStream(response.body, formatHint)) {
            if (cancelled) break;
            const parsed = extractStreamPayload(raw, customTextPath);
            if (parsed === "done") break;
            if (parsed) {
              if (parsed.reasoning) send(chunk({ reasoning_content: parsed.reasoning }));
              if (parsed.content) send(chunk({ content: parsed.content }));
              finish = parsed.finish || finish; usage = parsed.usage || usage;
            } else if (isSse && isPlainSse && raw && !raw.trim().startsWith("{")) {
              send(chunk({ content: raw }));
            }
          }
        }
        if (!cancelled) {
          send(chunk({}, finish || "stop"));
          if (usageRequested && usage) send({ id, object: "chat.completion.chunk", created, model: outputModel, choices: [], usage });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        await log(cancelled ? 499 : 200, cancelled ? "Client cancelled" : undefined);
      } catch {
        if (!cancelled) { send({ error: { message: "Upstream stream interrupted.", type: "api_error", code: "stream_error" } }); controller.enqueue(encoder.encode("data: [DONE]\n\n")); }
        await log(502, "Upstream stream interrupted");
      } finally { if (!cancelled) controller.close(); }
    },
    async cancel() { cancelled = true; await response.body?.cancel().catch(() => {}); },
  });
  return new Response(result, { headers: { ...cors, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
