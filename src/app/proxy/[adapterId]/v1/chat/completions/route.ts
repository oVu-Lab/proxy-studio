import { chat, options } from "@/lib/gateway";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ adapterId: string }> }) { return chat(request, (await context.params).adapterId); }
export const OPTIONS = options;
