import { getSiteDomain } from "@/domain/hosts";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import { readClaimUsername, withClaimUsername } from "@/domain/username-intent";
import { getSession } from "@/server/auth/session";
import { readRegistrationMode } from "@/server/invites";

export default async function Page({ searchParams }: { searchParams: Promise<{ username?: string | string[] }> }) {
  const username = readClaimUsername((await searchParams).username);
  if (username && await getSession(await headers())) redirect(withClaimUsername("/editor", username));
  return <AuthForm siteDomain={getSiteDomain()} mode="sign-up" claimUsername={username} registrationMode={await readRegistrationMode()} />;
}
