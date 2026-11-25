import {
  parseManualCaptureInput,
  pickBestCapturedPayload,
  type CapturedPayload,
} from "@/lib/capture-analyzer";
import { CAPTURE_CORS_HEADERS, ingestCapture } from "@/lib/capture-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 524_288; // 512 KB (covers copy(__proxyCapture.all) & big cURLs safely)

function corsJson(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      ...CAPTURE_CORS_HEADERS,
      "Cache-Control": "no-store",
    },
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CAPTURE_CORS_HEADERS });
}

export async function POST(request: Request) {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return corsJson({ ok: false, error: "Could not read the request body. Please try again." }, 400);
  }

  if (raw.length > MAX_BODY_BYTES) {
    return corsJson(
      { ok: false, error: "That pasted payload is over 512 KB. Try copying only the single chat request via copy(__proxyCapture.last)." },
      413,
    );
  }

  const reqUrl = new URL(request.url);
  const queryId = reqUrl.searchParams.get("sessionId")?.trim() || "";
  const trimmed = raw.trim();

  // Direct text paste (raw cURL or fetch) or JSON body
  let body: CapturedPayload | null = null;
  let bodySessionId = "";
  let customName = "";
  let customModel = "";

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return corsJson(
        {
          ok: false,
          error:
            "That JSON looked incomplete. Run copy(__proxyCapture.last) again in Console and paste the whole output.",
        },
        400,
      );
    }

    if (Array.isArray(parsed)) {
      body = pickBestCapturedPayload(parsed);
      if (!body) {
        return corsJson(
          {
            ok: false,
            error:
              "No chat request was found in that captured list yet. Send 1 message in the chat first, then type copy(__proxyCapture.last).",
          },
          400,
        );
      }
      if (typeof body.sessionId === "string") bodySessionId = body.sessionId.trim();
    } else if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.sessionId === "string") bodySessionId = obj.sessionId.trim();
      if (typeof obj.name === "string") customName = obj.name.trim();
      if (typeof obj.model === "string") customModel = obj.model.trim();

      // Manual Paste Fallback envelope: { manualText: "curl ... | fetch(...) | {...}" }
      if (typeof obj.manualText === "string") {
        try {
          body = parseManualCaptureInput(obj.manualText);
          if (!bodySessionId && typeof body.sessionId === "string") {
            bodySessionId = body.sessionId.trim();
          }
        } catch (err) {
          return corsJson(
            {
              ok: false,
              error:
                err instanceof Error
                  ? err.message
                  : "Could not read that pasted request. Paste copy(__proxyCapture.last) JSON or Copy as cURL.",
            },
            400,
          );
        }
      } else if (typeof obj.url === "string" && obj.url.trim()) {
        body = obj as unknown as CapturedPayload;
      } else if (obj.last && typeof obj.last === "object") {
        const last = obj.last as Record<string, unknown>;
        if (typeof last.url === "string") body = last as unknown as CapturedPayload;
      } else if (Array.isArray(obj.all)) {
        body = pickBestCapturedPayload(obj.all);
      }
    }
  } else {
    // Allow posting raw cURL or fetch directly to /api/capture/ingest?sessionId=...
    try {
      body = parseManualCaptureInput(trimmed);
    } catch (err) {
      return corsJson(
        {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : "Paste the JSON from copy(__proxyCapture.last), a Copy as cURL command, or a fetch(...) snippet.",
        },
        400,
      );
    }
  }

  const sessionId = queryId || bodySessionId;
  if (!sessionId || sessionId.length > 128) {
    return corsJson(
      { ok: false, error: "Missing session ID. Re-open Live Browser Capture to start a fresh session." },
      400,
    );
  }

  if (!body || typeof body.url !== "string" || !body.url.trim() || body.url.length > 4096) {
    return corsJson(
      {
        ok: false,
        error:
          "No chat endpoint URL found in the pasted payload. Run copy(__proxyCapture.last) after sending a message, or paste a Copy as cURL command.",
      },
      400,
    );
  }

  if (customName && !body.pageOrigin) {
    // Preserve optional display hint cleanly without spoiling origin validation
    body = { ...body };
  }
  if (customModel && body.requestBody && typeof body.requestBody === "object" && !Array.isArray(body.requestBody)) {
    const rb = { ...(body.requestBody as Record<string, unknown>) };
    if (!("model" in rb) && !("modelId" in rb) && !("model_id" in rb)) rb.model = customModel;
    body = { ...body, requestBody: rb };
  }

  const result = await ingestCapture(sessionId, body);
  return corsJson(result.body, result.httpStatus);
}
