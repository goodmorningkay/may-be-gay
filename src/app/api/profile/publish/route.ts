import { requireUser } from "@/server/auth/session";
import { apiError, apiJson, readJson } from "@/server/http";
import { expectedVersionSchema, publishProfile, requireEditorIdentity } from "@/server/profile-editor";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const principal = await requireUser(request);
    const profileId = requireEditorIdentity(request);
    const { expectedVersion } = await readJson(request, expectedVersionSchema, 1024);
    return apiJson(await publishProfile(principal, expectedVersion, profileId, { validated: true }));
  } catch (error) { return apiError(error); }
}
