import Studio from "@/components/Studio";
import { readDB } from "@/lib/store";
import { publicAdapter } from "@/lib/types";

export const dynamic = "force-dynamic";
export default async function Home() {
  const db = await readDB();
  return <Studio initial={{ adapters: db.adapters.map(publicAdapter), logs: db.logs.slice(0, 100), authRequired: Boolean(process.env.STUDIO_API_KEY || db.settings.localApiKey), envKey: Boolean(process.env.STUDIO_API_KEY) }} />;
}
