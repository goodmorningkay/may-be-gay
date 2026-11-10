import { requireUser } from "@/server/auth/session";
import { apiError, apiJson, readJson } from "@/server/http";
import { expectedVersionSchema, requireEditorIdentity, restoreProfileRevision } from "@/server/profile-editor";

export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireUser(request);
    const profileId = requireEditorIdentity(request);
    const { expectedVersion } = await readJson(request, expectedVersionSchema, 1024);
    const { id } = await context.params;
    return apiJson(await restoreProfileRevision(principal, id, expectedVersion, profileId));
  } catch (error) { return apiError(error); }
}
