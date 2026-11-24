import "server-only";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getSiteDomain, resolveHost } from "@/domain/hosts";
export async function requireApexPage() {
  if (resolveHost((await headers()).get("host"), getSiteDomain()).kind !== "apex") notFound();
}
