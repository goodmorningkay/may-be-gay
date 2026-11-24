import { requireUser } from "@/server/auth/session";
import { apiError, apiJson, readJson } from "@/server/http";
import { requireEditorIdentity, unpublishProfile, unpublishProfileSchema } from "@/server/profile-editor";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const principal = await requireUser(request);
    const profileId = requireEditorIdentity(request);
    await readJson(request, unpublishProfileSchema, 1024);
    return apiJson(await unpublishProfile(principal, profileId));
  } catch (error) { return apiError(error); }
}
