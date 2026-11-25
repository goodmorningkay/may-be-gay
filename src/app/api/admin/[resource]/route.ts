import { adminActionSchema } from "@/domain/operations";
import { apiJson, readJson } from "@/server/http";
import { requireAdmin } from "@/server/auth/session";
import { readAdmin, mutateAdmin } from "@/server/operations/admin";
import { operationsError } from "@/server/operations/core";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ resource: string }> }) {
  try { return apiJson(await readAdmin(request, (await context.params).resource, new URL(request.url))); }
  catch (error) { return operationsError(error); }
}
export async function POST(request: Request, context: { params: Promise<{ resource: string }> }) {
  try {
    const principal = await requireAdmin(request);
    if ((await context.params).resource !== "actions") return apiJson({ error: { code: "NOT_FOUND", message: "Action route unavailable." } }, 404);
    return apiJson(await mutateAdmin(principal, await readJson(request, adminActionSchema, 4096), true));
  } catch (error) { return operationsError(error); }
}
