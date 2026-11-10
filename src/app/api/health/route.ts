import { NextResponse, type NextRequest } from "next/server";
import { getSiteDomain, resolveHost } from "@/domain/hosts";
import { serviceState } from "@/server/service-state";

/** Nonsensitive application readiness; detailed worker/provider checks stay CLI-only. */
export async function GET(request: NextRequest) {
  if (resolveHost(request.headers.get("host"), getSiteDomain()).kind !== "app") {
    return new NextResponse(null, { status: 404 });
  }
  const ready = await serviceState() === "open";
  return NextResponse.json({ status: ready ? "ok" : "unavailable" }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
