import { submitReport } from "@/server/operations/reports";
import { assertPublicRequest } from "@/server/operations/public";
import { readReportBody, reportResponse } from "@/server/operations/report-http";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    assertPublicRequest(request, "apex");
    await submitReport(await readReportBody(request));
    return reportResponse(request, true);
  } catch { return reportResponse(request, false); }
}
