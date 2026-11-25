import { deleteAccountSchema } from "@/domain/operations";
import { requireAccountIdentity } from "@/server/account-identity";
import { apiJson, readJson } from "@/server/http";
import { requireUser } from "@/server/auth/session";
import { deleteAccount } from "@/server/operations/deletion";
import { operationsError } from "@/server/operations/core";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const principal = await requireUser(request, { recent: true });
    const expectedAccountId = requireAccountIdentity(request);
    const body = await readJson(request, deleteAccountSchema, 256);
    return apiJson(await deleteAccount({ principal, expectedAccountId }, body, true), 202);
  }
  catch (error) { return operationsError(error); }
}
