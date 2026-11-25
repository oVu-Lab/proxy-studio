import {
  generateCloudflareWorker,
  generateLocalProxyScript,
  generateMacCompanionLauncher,
  generateWindowsCompanionLauncher,
  generateWranglerToml,
} from "@/lib/exporters";
import { readDB } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      includeCredentials?: unknown;
      apiKey?: unknown;
      workerName?: unknown;
      port?: unknown;
    };
    const db = await readDB();
    const includeCredentials = body.includeCredentials === true;
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim().slice(0, 256) : "";
    const workerName = typeof body.workerName === "string" ? body.workerName.trim() : "my-ai-proxy-gateway";
    const port =
      typeof body.port === "number" && body.port >= 1 && body.port <= 65535
        ? Math.floor(body.port)
        : 8088;

    const enabled = db.adapters.filter((a) => a.enabled);
    const hasHiddenCredentials = enabled.some((a) =>
      Object.keys(a.headers || {}).some((k) =>
        /^(authorization|cookie|set-cookie|x-api-key|api-key|x-auth|x-session|x-token)/i.test(k),
      ),
    );

    return Response.json(
      {
        ok: true,
        enabledCount: enabled.length,
        modelCount: enabled.reduce((n, a) => n + a.models.length, 0),
        hasHiddenCredentials,
        includeCredentials,
        workerJs: generateCloudflareWorker(enabled, { includeCredentials, apiKey }),
        wranglerToml: generateWranglerToml(workerName),
        proxyMjs: generateLocalProxyScript(enabled, { includeCredentials, apiKey, port }),
        macLauncher: generateMacCompanionLauncher(port),
        windowsLauncher: generateWindowsCompanionLauncher(port),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Could not generate gateway files." },
      { status: 500 },
    );
  }
}
