import { discoverSite } from "@/lib/discovery";
import { createCaptureSession, resolveCallbackOrigin } from "@/lib/capture-sessions";
import { validateUrl } from "@/lib/network";
import { uniqueId, updateDB } from "@/lib/store";
import { publicAdapter } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let rawUrl = "";
  let callbackOriginOverride: unknown;
  try {
    const payload = (await request.json()) as { url?: unknown; callbackOrigin?: unknown };
    if (typeof payload.url !== "string" || !payload.url.trim() || payload.url.length > 2048) {
      return Response.json({ error: "Enter a valid website URL." }, { status: 400 });
    }
    rawUrl = payload.url.trim();
    callbackOriginOverride = payload.callbackOrigin;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Always enforce URL validation & SSRF protection first.
  let validated: URL;
  try {
    validated = await validateUrl(rawUrl);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Enter a valid website URL." },
      { status: 400 },
    );
  }

  const callbackOrigin = resolveCallbackOrigin(request, callbackOriginOverride);

  try {
    const result = await discoverSite(validated.toString());
    if (!result.adapter) {
      const captureSession = createCaptureSession({
        targetUrl: result.report.page || validated.toString(),
        callbackOrigin,
        reason: result.message,
        preDiscoveredModels: result.report.models,
      });
      return Response.json(
        {
          ok: false,
          fallback: "live-capture",
          error: result.message,
          report: result.report,
          captureSession,
        },
        { status: 422 },
      );
    }

    const incoming = result.adapter;
    const saved = await updateDB((db) => {
      const existing = db.adapters.find(
        (a) => a.endpoint === incoming.endpoint && a.origin === incoming.origin,
      );
      if (existing) {
        existing.verifiedAt = incoming.verifiedAt;
        return existing;
      }
      incoming.id = uniqueId(incoming.name, db.adapters);
      db.adapters.push(incoming);
      return incoming;
    });
    return Response.json({
      ok: true,
      adapter: publicAdapter(saved),
      report: result.report,
      message: result.message,
    });
  } catch (error) {
    // Pages gated behind auth walls, bot protection (403/401), or fetch timeouts automatically
    // transition into the live browser capture fallback session.
    const reason =
      error instanceof Error
        ? `${error.message} Switched to live browser capture so you can capture a chat request directly.`
        : "Static discovery could not inspect this page. Switched to live browser capture.";
    const captureSession = createCaptureSession({
      targetUrl: validated.toString(),
      callbackOrigin,
      reason,
    });
    return Response.json(
      {
        ok: false,
        fallback: "live-capture",
        error: reason,
        report: null,
        captureSession,
      },
      { status: 422 },
    );
  }
}
