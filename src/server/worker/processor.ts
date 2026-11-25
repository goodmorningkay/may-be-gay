import { workerConnection, type Claim, type WorkerSql } from "./queue";

const allowedFailures = new Set([
  "JOB_CLAIM_LOST",
  "MAIL_NOT_CONFIGURED",
  "PRIVATE_MAIL_OUTBOX_REQUIRED",
  "LOCAL_MAIL_WRITE_FAILED",
  "EMAIL_DELIVERY_FAILED",
  "MEDIA_PROVIDER_UNCONFIGURED",
  "MEDIA_STORAGE_UNAVAILABLE",
  "MEDIA_PARSER_BUSY",
  "MEDIA_PARSER_UNAVAILABLE",
  "MEDIA_RETAINED",
  "MEDIA_INVALID",
  "MEDIA_PROCESSING_LIMIT",
  "DRAFT_REPAIR_REQUIRED",
  "ACCOUNT_DELETION_NOT_REQUESTED",
  "ACCOUNT_MEDIA_BOUND_EXCEEDED",
]);

export function failureCode(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; message?: unknown; name?: unknown };
    if (typeof e.code === "string" && allowedFailures.has(e.code)) return e.code;
    if (typeof e.message === "string" && allowedFailures.has(e.message)) return e.message;
    if (e.name === "ZodError") return "INVALID_JOB_PAYLOAD";
  }
  return "PROCESSOR_FAILED";
}

export async function dispatch(c: Claim, passedSql?: WorkerSql) {
  if (c.payload_version !== 1) throw Object.assign(new Error(), { name: "ZodError" });
  switch (c.kind) {
    case "email": {
      const { processEmailJob } = await import("../mail");
      const sql = passedSql ?? workerConnection();
      try {
        const [live] = await sql`select id from jobs where id=${c.id} and state='running' and locked_by=${c.locked_by} and attempts=${c.attempts}`;
        if (!live) throw new Error("JOB_CLAIM_LOST");
        return await processEmailJob({ id: c.id, payload: c.payload });
      } finally {
        if (!passedSql) await sql.end({ timeout: 0 });
      }
    }
    case "media": {
      const { processMediaJob } = await import("../media/jobs");
      return processMediaJob(c.payload);
    }
    case "media_deletion": {
      const { processMediaDeletionJob } = await import("../media/jobs");
      return processMediaDeletionJob(c.payload);
    }
    case "cache_purge": {
      const { processCachePurgeJob } = await import("../media/jobs");
      return processCachePurgeJob(c.payload);
    }
    case "account_deletion": {
      const { processAccountDeletionJob } = await import("../operations/deletion");
      return processAccountDeletionJob(c.payload);
    }
    default:
      throw Object.assign(new Error(), { name: "ZodError" });
  }
}
