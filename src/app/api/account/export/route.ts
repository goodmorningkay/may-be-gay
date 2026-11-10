import { exportAccount } from "@/server/operations/export";
import { operationsError } from "@/server/operations/core";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// POST is intentional: private export requires the exact app Origin.
export async function POST(request: Request) {
  try { return await exportAccount(request); } catch (error) { return operationsError(error); }
}
