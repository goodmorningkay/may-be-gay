const allowed = new Set(["JOB_CLAIM_LOST", "MAIL_NOT_CONFIGURED", "PRIVATE_MAIL_OUTBOX_REQUIRED", "LOCAL_MAIL_WRITE_FAILED", "EMAIL_DELIVERY_FAILED", "MEDIA_PROVIDER_UNCONFIGURED", "MEDIA_STORAGE_UNAVAILABLE", "MEDIA_PARSER_BUSY", "MEDIA_PARSER_UNAVAILABLE", "MEDIA_RETAINED", "MEDIA_INVALID", "MEDIA_PROCESSING_LIMIT", "DRAFT_REPAIR_REQUIRED", "ACCOUNT_DELETION_NOT_REQUESTED", "ACCOUNT_MEDIA_BOUND_EXCEEDED"]);
export function failureCode(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; message?: unknown; name?: unknown };
    if (typeof e.code === "string" && allowed.has(e.code)) return e.code;
    if (typeof e.message === "string" && allowed.has(e.message)) return e.message;
    if (e.name === "ZodError") return "INVALID_JOB_PAYLOAD";
  }
  return "PROCESSOR_FAILED";
}
