import { metricSchema } from "@/domain/operations";
import { apiJson, readJson } from "@/server/http";
import { assertPublicRequest } from "@/server/operations/public";
import { recordMetric } from "@/server/operations/analytics";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const host = assertPublicRequest(request, "profile");
    if (request.headers.get("dnt") === "1" || request.headers.get("sec-gpc") === "1" || request.headers.has("next-router-prefetch") || request.headers.has("rsc") || request.headers.get("purpose") === "prefetch") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    const input = await readJson(request, metricSchema, 256);
    if (host.kind === "profile") await recordMetric(host.username, input);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch { return apiJson({ error: { code: "METRIC_REJECTED", message: "Event unavailable." } }, 400); }
}
