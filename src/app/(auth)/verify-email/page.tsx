import { AuthForm } from "@/components/auth/auth-form";
export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string; verified?: string }> }) {
  const params = await searchParams;
  return <AuthForm mode="verify-email" verificationStatus={params.error ? "error" : params.verified === "1" ? "success" : undefined} />;
}
