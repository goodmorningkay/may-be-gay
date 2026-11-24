import { requireApexPage } from "@/server/operations/pages";
import { getReportTargets } from "@/server/operations/reports";
import { policyConfiguration } from "@/server/operations/policy";
import { getSiteDomain, isValidUsername } from "@/domain/hosts";
import { SupportWorkspace } from "@/components/operations/report-form";

export const dynamic = "force-dynamic";

export default async function SupportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireApexPage();
  const q = await searchParams;
  const config = policyConfiguration();
  const username = typeof q.username === "string" && isValidUsername(q.username) ? q.username : "";
  const targets = username ? await getReportTargets(username) : [];
  const requested = typeof q.linkId === "string" ? `link:${q.linkId.toLowerCase()}` : typeof q.mediaId === "string" ? `media:${q.mediaId.toLowerCase()}` : "";
  const target = targets.some(option => option.value === requested) ? requested : "";
  const supportEmail = config.supportMonitored ? config.values.supportEmail : undefined;
  return <SupportWorkspace key={`${username}:${target}`} domain={getSiteDomain()} username={username} targets={targets}
    target={target} supportEmail={supportEmail} appealsEmail={supportEmail ? config.values.appealsEmail : undefined} />;
}
