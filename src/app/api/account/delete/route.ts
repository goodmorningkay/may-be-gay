import { deleteAccountSchema } from "@/domain/operations";
import { apiJson, readJson } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { deleteAccount } from "@/server/operations/deletion";
import { operationsError } from "@/server/operations/core";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try { await requireUser(request, { recent: true }); return apiJson(await deleteAccount(request, await readJson(request, deleteAccountSchema, 256)), 202); }
  catch (error) { return operationsError(error); }
}
