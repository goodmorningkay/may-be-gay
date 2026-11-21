import { AuthForm } from "@/components/auth/auth-form";
import { readClaimUsername } from "@/domain/username-intent";

export default async function Page({ searchParams }: { searchParams: Promise<{ username?: string | string[] }> }) {
  return <AuthForm mode="sign-in" claimUsername={readClaimUsername((await searchParams).username)} />;
}
