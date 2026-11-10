import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Transaction } from "@/server/db/types";
import { profiles } from "@/server/db/schema";
import { MediaError } from "./errors";

export function requireMediaEditorIdentity(request: Request): string {
  const parsed = z.string().uuid().safeParse(request.headers.get("x-editor-profile"));
  if (!parsed.success) throw new MediaError(400, "EDITOR_IDENTITY_REQUIRED", "Reload the editor before accessing its media library.");
  return parsed.data.toLowerCase();
}

/** Call after locking the session-derived owner, before any media access. The
 * supplied profile is a precondition, never an authority to select an owner. */
export async function checkMediaEditor(tx: Transaction, ownerId: string, expectedProfileId?: string) {
  // Internal worker/service callers have no editor identity. HTTP collection and
  // deletion routes always require it; native content loads authorize asset IDs.
  if (expectedProfileId === undefined) return;
  const [profile] = await tx.select({ id: profiles.id }).from(profiles).where(eq(profiles.ownerId, ownerId)).for("update");
  if (profile?.id !== expectedProfileId) throw new MediaError(409, "ACCOUNT_CHANGED", "Sign in to the account that opened this editor before accessing its media library.");
}
