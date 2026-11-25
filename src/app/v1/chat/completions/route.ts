import { chat, options } from "@/lib/gateway";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = (request: Request) => chat(request);
export const OPTIONS = options;
