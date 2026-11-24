import { getSiteDomain } from "@/domain/hosts";
import { apiError } from "@/server/http";
import { MediaError } from "@/server/media/errors";
import { mediaResponse } from "@/server/media/responses";
import { readLocalPublicContent } from "@/server/media/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ key: string[] }> }) {
  try {
    const host = request.headers.get("host")?.toLowerCase();
    if (getSiteDomain() !== "may-be.localhost" || (host !== "media.may-be.localhost" && host !== "media.may-be.localhost:443")) {
      throw new MediaError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
    }
    const { body, object } = await readLocalPublicContent((await context.params).key.join("/"));
    return mediaResponse(body, object, request);
  } catch (error) { return apiError(error); }
}
