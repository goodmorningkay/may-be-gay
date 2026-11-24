import { requireUser } from "@/server/auth/session";
import { apiError } from "@/server/http";
import { readPrivateContent } from "@/server/media/service";
import { mediaResponse } from "@/server/media/responses";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireUser(request);
    const { body, object } = await readPrivateContent(principal.userId, (await context.params).id);
    const response = mediaResponse(body, object, request);
    response.headers.set("cross-origin-resource-policy", "same-origin");
    return response;
  } catch (error) { return apiError(error); }
}
