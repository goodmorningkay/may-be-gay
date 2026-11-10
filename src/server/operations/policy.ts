import "server-only";
import { z } from "zod";
const text = z.string().trim().min(1).max(3000);
const fields = {
  operator: "OPERATOR_IDENTITY", jurisdiction: "OPERATOR_JURISDICTION", audience: "POLICY_AUDIENCE_AGE",
  contentRules: "POLICY_CONTENT_RULES", supportEmail: "SUPPORT_EMAIL", appealsEmail: "APPEALS_EMAIL",
  mediaRights: "POLICY_MEDIA_RIGHTS_TAKEDOWN", privacy: "POLICY_PRIVACY_NOTICE", terms: "POLICY_TERMS",
} as const;
export function policyConfiguration(env: Partial<NodeJS.ProcessEnv> = process.env) {
  const values: Partial<Record<keyof typeof fields, string>> = {}, missing: string[] = [];
  for (const [key, variable] of Object.entries(fields)) {
    const value = (key.endsWith("Email") ? z.email().max(254) : text).safeParse(env[variable]);
    if (value.success && !/[\u0000-\u001f\u007f]/.test(value.data) && (!key.endsWith("Email") || !/[?&#%]/.test(value.data))) values[key as keyof typeof fields] = value.data;
    else missing.push(variable);
  }
  if (env.POLICY_REVIEWED !== "true") missing.push("POLICY_REVIEWED");
  if (env.SUPPORT_MONITORED !== "true") missing.push("SUPPORT_MONITORED");
  return { values, missing, ready: missing.length === 0, reviewed: env.POLICY_REVIEWED === "true", supportMonitored: env.SUPPORT_MONITORED === "true" };
}
export const launchReadiness = policyConfiguration;
