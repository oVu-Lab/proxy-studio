import type { ResponseFormat } from "@/lib/types";

/**
 * Pure, runtime-agnostic parser for LLM streaming and JSON responses.
 * Runs identically on Node.js servers, browsers (Global Mode), and Cloudflare Workers.
 */

export type ExtractedChunk = {
  content: string;
  reasoning: string;
  finish: string | null;
  usage?: unknown;
  model?: string;
  matched: boolean;
  format?: ResponseFormat;
};

const BLOCKED_PATH_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function getPath(target: unknown, path: string[]): unknown {
  let cur: unknown = target;
  for (const part of path) {
    if (!cur || typeof cur !== "object" || BLOCKED_PATH_KEYS.has(part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function setPath(target: Record<string, unknown>, path: string[], value: unknown) {
  if (!path.length) return;
  let obj = target;
  for (const part of path.slice(0, -1)) {
    if (BLOCKED_PATH_KEYS.has(part)) return;
    const next = obj[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) obj[part] = {};
    obj = obj[part] as Record<string, unknown>;
  }
  const leaf = path[path.length - 1];
  if (!BLOCKED_PATH_KEYS.has(leaf)) obj[leaf] = value;
}

/** Extract assistant text, reasoning, finish_reason, usage, and model across OpenAI, Anthropic, Gemini, and custom shapes. */
export function extractText(
  payload: Record<string, unknown>,
  customTextPath?: string[],
): ExtractedChunk {
  const model =
    typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : undefined;

  // 1. OpenAI shape (chat.completion & chat.completion.chunk)
  if (Array.isArray(payload.choices)) {
    const choice = payload.choices[0] as Record<string, unknown> | undefined;
    if (choice && typeof choice === "object") {
      const delta =
        choice.delta && typeof choice.delta === "object"
          ? (choice.delta as Record<string, unknown>)
          : undefined;
      const msg =
        choice.message && typeof choice.message === "object"
          ? (choice.message as Record<string, unknown>)
          : undefined;
      const content =
        typeof delta?.content === "string"
          ? delta.content
          : typeof msg?.content === "string"
            ? msg.content
            : typeof choice.text === "string"
              ? choice.text
              : "";
      const reasoningRaw =
        delta?.reasoning_content ??
        delta?.reasoning ??
        msg?.reasoning_content ??
        msg?.reasoning;
      const reasoning = typeof reasoningRaw === "string" ? reasoningRaw : "";
      const finish = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
      return {
        content,
        reasoning,
        finish,
        usage: payload.usage,
        model,
        matched: true,
        format: "openai-sse",
      };
    }
    if (payload.usage) {
      return {
        content: "",
        reasoning: "",
        finish: null,
        usage: payload.usage,
        model,
        matched: true,
        format: "openai-sse",
      };
    }
  }

  // 2. Anthropic SSE (`content_block_delta`, `message_start`, `message_delta`) & Messages JSON
  if (payload.type === "content_block_delta" && payload.delta && typeof payload.delta === "object") {
    const d = payload.delta as Record<string, unknown>;
    const content = typeof d.text === "string" ? d.text : "";
    const reasoning = typeof d.thinking === "string" ? d.thinking : "";
    return {
      content,
      reasoning,
      finish: null,
      usage: payload.usage,
      model,
      matched: true,
      format: "anthropic-sse",
    };
  }
  if (
    payload.type === "message_start" ||
    payload.type === "message_delta" ||
    payload.type === "message_stop" ||
    payload.type === "content_block_start"
  ) {
    const d =
      payload.delta && typeof payload.delta === "object"
        ? (payload.delta as Record<string, unknown>)
        : undefined;
    const msg =
      payload.message && typeof payload.message === "object"
        ? (payload.message as Record<string, unknown>)
        : undefined;
    const stopReason = typeof d?.stop_reason === "string" ? "stop" : null;
    const msgModel = typeof msg?.model === "string" ? msg.model : model;
    return {
      content: "",
      reasoning: "",
      finish: stopReason,
      usage: payload.usage ?? msg?.usage,
      model: msgModel,
      matched: true,
      format: "anthropic-sse",
    };
  }
  if (Array.isArray(payload.content)) {
    const parts = payload.content as Record<string, unknown>[];
    const texts: string[] = [];
    const thoughts: string[] = [];
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
      else if (p.type === "thinking" && typeof p.thinking === "string") thoughts.push(p.thinking);
    }
    if (texts.length || thoughts.length) {
      return {
        content: texts.join(""),
        reasoning: thoughts.join(""),
        finish: "stop",
        usage: payload.usage,
        model,
        matched: true,
        format: "json",
      };
    }
  }

  // 3. Gemini (`candidates[0].content.parts[].text`)
  if (Array.isArray(payload.candidates)) {
    const cand = payload.candidates[0] as Record<string, unknown> | undefined;
    const cObj =
      cand?.content && typeof cand.content === "object"
        ? (cand.content as Record<string, unknown>)
        : undefined;
    const parts = Array.isArray(cObj?.parts) ? (cObj.parts as Record<string, unknown>[]) : [];
    const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
    if (text || cand?.finishReason) {
      return {
        content: text,
        reasoning: "",
        finish:
          typeof cand?.finishReason === "string" && cand.finishReason !== "NONE" ? "stop" : null,
        usage: payload.usageMetadata,
        model: typeof payload.modelVersion === "string" ? payload.modelVersion : model,
        matched: true,
        format: "custom-sse",
      };
    }
  }

  // 4. Configured custom path detected during capture analysis
  if (customTextPath && customTextPath.length > 0) {
    const val = getPath(payload, customTextPath);
    if (typeof val === "string") {
      return {
        content: val,
        reasoning:
          typeof payload.thinking === "string"
            ? payload.thinking
            : typeof payload.reasoning === "string"
              ? payload.reasoning
              : "",
        finish: payload.done === true || payload.finished === true ? "stop" : null,
        usage: payload.usage,
        model,
        matched: true,
        format: "custom-sse",
      };
    }
  }

  // 5. Common custom LLM SSE / NDJSON / JSON / WebSocket fields
  const genericDelta =
    payload.delta && typeof payload.delta === "object"
      ? (payload.delta as Record<string, unknown>)
      : undefined;
  const nestedMessage =
    payload.message && typeof payload.message === "object"
      ? (payload.message as Record<string, unknown>)
      : undefined;
  const nestedData =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : undefined;

  const candidates: unknown[] = [
    typeof payload.delta === "string" ? payload.delta : undefined,
    genericDelta?.content,
    genericDelta?.text,
    nestedMessage?.content,
    nestedMessage?.text,
    payload.content,
    payload.response,
    payload.reply,
    payload.answer,
    payload.output_text,
    payload.output,
    payload.token,
    payload.chunk,
    payload.text,
    payload.completion,
    payload.generated_text,
    payload.result,
    nestedData?.content,
    nestedData?.text,
    nestedData?.delta,
    nestedData?.token,
    nestedData?.chunk,
    nestedData?.reply,
    nestedData?.response,
    nestedData?.answer,
    nestedData?.output,
  ];
  const found = candidates.find((v): v is string => typeof v === "string");
  const reasoningCandidate = [
    payload.reasoning_content,
    payload.reasoning,
    payload.thinking,
    nestedMessage?.thinking,
    nestedMessage?.reasoning_content,
    genericDelta?.reasoning_content,
    genericDelta?.thinking,
  ].find((v): v is string => typeof v === "string");

  if (found !== undefined || reasoningCandidate !== undefined) {
    const done =
      payload.done === true ||
      payload.finished === true ||
      payload.complete === true ||
      payload.finish_reason === "stop" ||
      payload.type === "done" ||
      payload.type === "end";
    return {
      content: found ?? "",
      reasoning: reasoningCandidate ?? "",
      finish: done ? "stop" : null,
      usage: payload.usage,
      model,
      matched: true,
      format: "custom-sse",
    };
  }

  return { content: "", reasoning: "", finish: null, model, matched: false };
}

/** Parse one line/frame of SSE, NDJSON, WebSocket, or Vercel AI stream into an ExtractedChunk. */
export function extractStreamPayload(
  raw: string,
  customTextPath?: string[],
): ExtractedChunk | "done" | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === "[DONE]" || trimmed === "DONE" || trimmed === "[END]") return "done";

  // Vercel AI SDK Data Stream protocol (`0:"hello"`)
  const vercelMatch = trimmed.match(/^0:("(?:[^"\\]|\\.)*")$/);
  if (vercelMatch) {
    try {
      const content = JSON.parse(vercelMatch[1]);
      if (typeof content === "string") {
        return { content, reasoning: "", finish: null, matched: true, format: "custom-sse" };
      }
    } catch {
      /* ignore */
    }
  }
  if (/^[de]:\{/.test(trimmed)) {
    return {
      content: "",
      reasoning: "",
      finish: trimmed.startsWith("d:") ? "stop" : null,
      matched: true,
      format: "custom-sse",
    };
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const res = extractText(parsed as Record<string, unknown>, customTextPath);
        if (res.matched) return res;
      }
    } catch {
      /* not valid JSON */
    }
    return null;
  }

  return null;
}

/** SSE parser supporting split UTF-8, CRLF, and multi-line data fields. */
export async function* parseSSE(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = done ? "" : lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) {
          if (data.length) {
            yield data.join("\n");
            data = [];
          }
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).trimStart());
        }
      }
      if (done) {
        if (data.length) yield data.join("\n");
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Universal line-based streaming parser for SSE (`data:`), NDJSON (`{...}`), and Vercel AI data streams. */
export async function* parseAnyStream(
  body: ReadableStream<Uint8Array> | null,
  hint?: ResponseFormat,
): AsyncGenerator<{ raw: string; isSse: boolean }> {
  if (!body) return;
  if (hint === "openai-sse" || hint === "anthropic-sse") {
    for await (const frame of parseSSE(body)) {
      yield { raw: frame, isSse: true };
    }
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let sseData: string[] = [];
  let sawSse = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = done ? "" : lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          if (sseData.length) {
            yield { raw: sseData.join("\n"), isSse: true };
            sseData = [];
          }
          continue;
        }
        if (line.startsWith("data:")) {
          sawSse = true;
          sseData.push(line.slice(5).trimStart());
        } else if (
          line.startsWith("event:") ||
          line.startsWith("id:") ||
          line.startsWith("retry:") ||
          line.startsWith(":")
        ) {
          sawSse = true;
        } else if (!sawSse && (trimmed.startsWith("{") || /^[0ed]:/.test(trimmed))) {
          yield { raw: trimmed, isSse: false };
        }
      }
      if (done) {
        if (sseData.length) yield { raw: sseData.join("\n"), isSse: true };
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
