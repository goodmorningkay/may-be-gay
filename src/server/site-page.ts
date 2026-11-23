import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { getSiteDomain, resolveHost } from "@/domain/hosts";
import { getPublishedProfile } from "@/server/profiles";

// Share the same published revision between the layout, metadata and page for
// this request. Publishing and suspension are visible on the next request.
export const readSitePage = cache(async () => {
  const domain = getSiteDomain();
  const host = resolveHost((await headers()).get("host"), domain);
  const profile = host.kind === "profile" ? await getPublishedProfile(host.username) : null;
  return { domain, host, profile };
});
