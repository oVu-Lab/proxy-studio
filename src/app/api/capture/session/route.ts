import { createCaptureSession, resolveCallbackOrigin } from "@/lib/capture-sessions";
import { validateUrl } from "@/lib/network";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      url?: unknown;
      callbackOrigin?: unknown;
      reason?: unknown;
    };
    let targetUrl = "https://example.com";
    if (typeof body.url === "string" && body.url.trim()) {
      if (body.url.length > 2048) {
        return Response.json({ error: "Enter a valid website URL." }, { status: 400 });
      }
      const parsed = await validateUrl(body.url.trim());
      targetUrl = parsed.toString();
    }
    const callbackOrigin = resolveCallbackOrigin(request, body.callbackOrigin);
    const session = createCaptureSession({
      targetUrl,
      callbackOrigin,
      reason:
        typeof body.reason === "string" && body.reason.trim()
          ? body.reason.trim().slice(0, 400)
          : "Run the interceptor on the target site and send one chat message. Proxy Studio will auto-analyze, probe, and save the adapter.",
    });
    return Response.json({ ok: true, session }, { status: 201 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not start capture session." },
      { status: 400 },
    );
  }
}
