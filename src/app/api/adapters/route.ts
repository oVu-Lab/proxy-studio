import { analyzeCapture, parseManualCaptureInput } from "@/lib/capture-analyzer";
import { translateProbeError } from "@/lib/human-errors";
import { validateUrl } from "@/lib/network";
import { probeAdapter } from "@/lib/proxy";
import { uniqueId, updateDB } from "@/lib/store";
import { publicAdapter } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      request?: unknown;
      name?: unknown;
      model?: unknown;
    };
    if (typeof body.request !== "string" || body.request.length > 350_000) {
      return Response.json(
        { error: "Paste a cURL command, fetch(...) snippet, or copy(__proxyCapture.last) JSON under 350 KB." },
        { status: 400 },
      );
    }

    const customName = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    const customModel = typeof body.model === "string" ? body.model.trim().slice(0, 100) : "";

    const captured = parseManualCaptureInput(body.request);
    const analyzed = analyzeCapture(captured, captured.pageUrl || captured.url);
    if (!analyzed.accepted) {
      return Response.json(
        { error: analyzed.message, hint: analyzed.actionTip },
        { status: 400 },
      );
    }

    const adapter = analyzed.adapter;
    adapter.source = "imported";
    if (customName) adapter.name = customName;
    if (customModel && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(customModel)) {
      if (!adapter.models.some((m) => m.id === customModel)) {
        adapter.models.unshift({ id: customModel, name: customModel });
      }
      if (!adapter.schema.model.length && adapter.method === "POST") {
        adapter.schema.model = ["model"];
      }
    }

    await validateUrl(adapter.endpoint, adapter.method === "WS");

    const result = await probeAdapter(adapter);
    if (!result.ok) {
      const friendly = translateProbeError({
        statusCode: result.statusCode,
        rawMessage: result.message,
        timedOut: result.timedOut,
        transport: analyzed.transport,
      });
      return Response.json(
        { error: friendly.message, title: friendly.title, hint: friendly.actionTip, code: friendly.code },
        { status: 422 },
      );
    }

    adapter.schema.responseFormat = result.detectedFormat || analyzed.inferredFormat;
    adapter.verifiedAt = new Date().toISOString();
    const saved = await updateDB((db) => {
      adapter.id = uniqueId(adapter.name, db.adapters);
      db.adapters.push(adapter);
      return adapter;
    });
    return Response.json({ ok: true, adapter: publicAdapter(saved), probe: result }, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not read that request. Try right-clicking the request in DevTools → Network → Copy as cURL.",
      },
      { status: 400 },
    );
  }
}
