import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSiteDomain } from "@/domain/hosts";
import { AuthForm } from "@/components/auth/auth-form";
import { resolveSignedInPath } from "@/domain/auth-redirect";
import { readClaimUsername } from "@/domain/username-intent";
import { getSession } from "@/server/auth/session";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ username?: string | string[]; returnTo?: string | string[] }>;
}) {
  const params = await searchParams;
  const session = await getSession(await headers());
  if (session) {
    redirect(resolveSignedInPath({
      returnTo: params.returnTo,
      username: params.username,
      emailVerified: session.emailVerified,
    }));
  }
  return <AuthForm siteDomain={getSiteDomain()} mode="sign-in" claimUsername={readClaimUsername(params.username)} />;
}
