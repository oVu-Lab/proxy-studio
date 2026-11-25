import { closeCaptureSession, getCaptureSession } from "@/lib/capture-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const session = getCaptureSession(id);
  if (!session) {
    return Response.json(
      { error: "Capture session not found or expired." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(
    { ok: true, session },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const removed = closeCaptureSession(id);
  return Response.json({ ok: removed }, { status: removed ? 200 : 404 });
}
