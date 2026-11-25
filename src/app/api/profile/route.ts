import { requireUser } from "@/server/auth/session";
import { apiError, apiJson, readJson } from "@/server/http";
import { getProfileEditor, requireEditorIdentity, saveProfile, saveProfileSchema } from "@/server/profile-editor";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { return apiJson(await getProfileEditor(await requireUser(request))); }
  catch (error) { return apiError(error); }
}

export async function PUT(request: Request) {
  try {
    const principal = await requireUser(request);
    const profileId = requireEditorIdentity(request);
    return apiJson(await saveProfile(principal, await readJson(request, saveProfileSchema, 128 * 1024), profileId, { validated: true }));
  } catch (error) { return apiError(error); }
}
