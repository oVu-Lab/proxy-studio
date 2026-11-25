import { listModels, options } from "@/lib/gateway";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = (request: Request) => listModels(request);
export const OPTIONS = options;
