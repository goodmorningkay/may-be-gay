import { z } from "zod";
import { claimUsername } from "@/server/accounts";
import { requireUser } from "@/server/auth/session";
import { apiJson, apiError, readJson } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
export async function POST(request: Request) {
  try {
    const p = await requireUser(request);
    await rateLimit(`claim:${p.userId}`, 10, 3600);
    const { username } = await readJson(request, z.object({ username: z.string().max(30) }).strict());
    return apiJson(await claimUsername(p, username), 201);
  } catch (error) { return apiError(error); }
}
