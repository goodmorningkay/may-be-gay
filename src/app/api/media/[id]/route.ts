import { requireUser } from "@/server/auth/session";
import { apiError, apiJson } from "@/server/http";
import { deleteOwnedMedia } from "@/server/media/service";
import { requireMediaEditorIdentity } from "@/server/media/identity";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireUser(request);
    await deleteOwnedMedia(principal.userId, (await context.params).id, requireMediaEditorIdentity(request));
    return apiJson({ accepted: true }, 202);
  } catch (error) { return apiError(error); }
}
