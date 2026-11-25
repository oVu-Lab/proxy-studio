import { updateDB } from "@/lib/store";
import { validateUrl } from "@/lib/network";
import { publicAdapter, type Model } from "@/lib/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.endpoint === "string") await validateUrl(body.endpoint);
    for (const field of ["origin", "referer"] as const) if (typeof body[field] === "string") { const u = new URL(body[field]); if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error(`Invalid ${field}.`); }
    const updated = await updateDB((db) => {
      const adapter = db.adapters.find((a) => a.id === id);
      if (!adapter) return null;
      if (typeof body.name === "string" && body.name.trim()) adapter.name = body.name.trim().slice(0, 80);
      if (typeof body.enabled === "boolean") adapter.enabled = body.enabled;
      if (typeof body.endpoint === "string" && body.endpoint !== adapter.endpoint) { adapter.endpoint = body.endpoint; adapter.verifiedAt = null; }
      if (typeof body.origin === "string" && body.origin !== adapter.origin) { adapter.origin = new URL(body.origin).origin; adapter.verifiedAt = null; }
      if (typeof body.referer === "string") adapter.referer = body.referer;
      if (Array.isArray(body.models)) {
        const models: Model[] = body.models.filter((m): m is string => typeof m === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(m)).slice(0, 100).map((m) => ({ id: m, name: m }));
        if (models.length) adapter.models = models;
      }
      if (body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)) {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(body.headers)) if (typeof value === "string" && key.length < 100 && value.length < 10000) headers[key] = value;
        adapter.headers = headers; adapter.verifiedAt = null;
      }
      return adapter;
    });
    return updated ? Response.json({ ok: true, adapter: publicAdapter(updated) }) : Response.json({ error: "Adapter not found." }, { status: 404 });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "Invalid adapter." }, { status: 400 }); }
}
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const removed = await updateDB((db) => { const old = db.adapters.length; db.adapters = db.adapters.filter((a) => a.id !== id); return db.adapters.length !== old; });
  return Response.json({ ok: removed }, { status: removed ? 200 : 404 });
}
