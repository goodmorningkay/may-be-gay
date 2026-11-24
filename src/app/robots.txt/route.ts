import { NextResponse, type NextRequest } from "next/server";
import { getSiteDomain, resolveHost } from "@/domain/hosts";
import { getPublishedProfile } from "@/server/profiles";

export async function GET(request: NextRequest) {
  const host = resolveHost(request.headers.get("host"), getSiteDomain());
  if (host.kind === "invalid") return new NextResponse(null, { status: 404 });
  if (host.kind === "profile" && !await getPublishedProfile(host.username)) return new NextResponse(null, { status: 404 });
  // Profile-specific noindex is emitted from the published document's metadata.
  // Crawlers must be able to fetch the page to see that directive.
  const rule = host.kind === "profile" ? "Allow: /" : "Disallow: /";
  return new NextResponse(`User-agent: *\n${rule}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
