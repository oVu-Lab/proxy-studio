import { readDB, updateDB } from "@/lib/store";
import { probeAdapter } from "@/lib/proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const db = await readDB();
  const adapter = db.adapters.find((a) => a.id === id);
  if (!adapter) return Response.json({ ok: false, message: "Adapter not found." }, { status: 404 });
  const result = await probeAdapter(adapter);
  if (result.ok) await updateDB((data) => { const saved = data.adapters.find((a) => a.id === id); if (saved) saved.verifiedAt = new Date().toISOString(); });
  return Response.json(result, { status: result.ok ? 200 : 422 });
}
