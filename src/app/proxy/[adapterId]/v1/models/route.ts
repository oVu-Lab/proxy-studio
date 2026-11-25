import { listModels, options } from "@/lib/gateway";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ adapterId: string }> }) { return listModels(request, (await context.params).adapterId); }
export const OPTIONS = options;
