import { requireUser } from "@/server/auth/session";
import { apiError, apiJson, assertMutationOrigin } from "@/server/http";
import { MediaError } from "@/server/media/errors";
import { listOwnedMedia, uploadMedia } from "@/server/media/service";
import { rateLimit } from "@/server/rate-limit";
import { requireMediaEditorIdentity } from "@/server/media/identity";
import { mediaIngress } from "@/server/media/ingress";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return mediaIngress(request, async () => {
    try { const principal = await requireUser(request); return apiJson(await listOwnedMedia(principal.userId, requireMediaEditorIdentity(request))); }
    catch (error) { return apiError(error); }
  });
}
export async function POST(request: Request) {
  return mediaIngress(request, async () => {
    try {
      assertMutationOrigin(request);
      const principal = await requireUser(request);
      const profileId = requireMediaEditorIdentity(request);
      await rateLimit(`media:upload:${principal.userId}`, 20, 3600);
      const url = new URL(request.url), kind = url.searchParams.get("kind");
      if ((kind !== "image" && kind !== "audio") || url.searchParams.getAll("kind").length !== 1 || [...url.searchParams.keys()].some(key => key !== "kind")) {
        throw new MediaError(400, "MEDIA_KIND_REQUIRED", "Choose kind=image or kind=audio and send a raw file body.");
      }
      return apiJson(await uploadMedia(principal.userId, kind, request.body, profileId), 202);
    } catch (error) { return apiError(error); }
  });
}
export const HEAD = GET;
export async function PUT(request: Request) { return mediaIngress(request, async () => apiJson({}, 405)); }
export const PATCH = PUT;
export const DELETE = PUT;
export const OPTIONS = PUT;
