import { updateDB } from "@/lib/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function PUT(request: Request) {
  if (process.env.STUDIO_API_KEY) return Response.json({ error: "STUDIO_API_KEY is set in the environment; remove it to change the local key here." }, { status: 400 });
  const body = await request.json() as { localApiKey?: unknown };
  if (typeof body.localApiKey !== "string" || body.localApiKey.length > 512) return Response.json({ error: "Key must be a string under 512 characters." }, { status: 400 });
  await updateDB((db) => { db.settings.localApiKey = body.localApiKey as string; });
  return Response.json({ ok: true, authRequired: Boolean(body.localApiKey) });
}
