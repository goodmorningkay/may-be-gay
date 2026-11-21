import { AuthForm } from "@/components/auth/auth-form";
import { readClaimUsername } from "@/domain/username-intent";

export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string; verified?: string; username?: string | string[] }> }) {
  const params = await searchParams;
  return <AuthForm mode="verify-email" claimUsername={readClaimUsername(params.username)} verificationStatus={params.error ? "error" : params.verified === "1" ? "success" : undefined} />;
}
