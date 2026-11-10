import { z } from "zod";
import { listAccountSessions, revokeAccountSessions } from "@/server/accounts";
import { apiJson, apiError, readJson } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { rateLimit } from "@/server/rate-limit";
export async function GET(request: Request) {
  try { return apiJson({ sessions: await listAccountSessions(request) }); } catch (error) { return apiError(error); }
}
export async function DELETE(request: Request) {
  try {
    const p = await requireUser(request, { recent: true });
    await rateLimit(`sessions:${p.userId}`, 20, 60);
    const { sessionId } = await readJson(request, z.object({ sessionId: z.string().max(128).optional() }).strict());
    await revokeAccountSessions(request, sessionId); return apiJson({ status: true });
  } catch (error) { return apiError(error); }
}
