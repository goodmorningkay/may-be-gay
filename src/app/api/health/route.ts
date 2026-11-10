import { NextResponse, type NextRequest } from "next/server";
import { getSiteDomain, resolveHost } from "@/domain/hosts";

/** Liveness only: readiness/migrations are handled by Compose dependencies. */
export function GET(request: NextRequest) {
  if (resolveHost(request.headers.get("host"), getSiteDomain()).kind !== "app") {
    return new NextResponse(null, { status: 404 });
  }
  return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
