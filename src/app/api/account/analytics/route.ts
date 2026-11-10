import { apiJson } from "@/server/http";
import { operationsError } from "@/server/operations/core";
import { readAnalytics } from "@/server/operations/analytics";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { return apiJson(await readAnalytics(request)); } catch (error) { return operationsError(error); }
}
