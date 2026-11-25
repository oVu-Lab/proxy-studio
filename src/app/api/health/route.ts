import { readDB } from "@/lib/store";
export const dynamic = "force-dynamic";
export async function GET() { try { await readDB(); return Response.json({ ok: true, storage: "local-json" }); } catch { return Response.json({ ok: false, storage: "local-json" }, { status: 500 }); } }
