import { readDB } from "@/lib/store";
import { publicAdapter } from "@/lib/types";
export const dynamic = "force-dynamic";
export async function GET() {
  const db = await readDB();
  return Response.json({ adapters: db.adapters.map(publicAdapter), logs: db.logs.slice(0, 100), authRequired: Boolean(process.env.STUDIO_API_KEY || db.settings.localApiKey), envKey: Boolean(process.env.STUDIO_API_KEY) }, { headers: { "Cache-Control": "no-store" } });
}
