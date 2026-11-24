/** Private operator CLI. Never import this into application route code. */
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { getDatabase, closeDatabase } from "../src/server/db";
import { user, session, auditEvents } from "../src/server/db/schema";
import { normalizeEmail, issueInvite } from "../src/server/invites";

async function main() {
  const { values } = parseArgs({ options: { email: { type: "string" }, invite: { type: "boolean" }, designate: { type: "boolean" } } });
  if (!values.email || Boolean(values.invite) === Boolean(values.designate)) throw new Error("Use --email address with exactly one of --invite or --designate");
  if (process.env.ACCOUNT_BOOTSTRAP_ENABLED !== "true") throw new Error("ACCOUNT_BOOTSTRAP_ENABLED=true required for this private operator action");
  const email = normalizeEmail(values.email);
  if (values.invite) {
    // Token stays in durable private outbox. Nothing sensitive is printed.
    const invite = await issueInvite({ email, bootstrap: true, sendEmail: true });
    console.log(`Bootstrap invitation queued: ${invite.id}. Deliver only with the explicitly configured private mail transport.`);
  } else {
    await getDatabase().transaction(async tx => {
      const [owner] = await tx.select().from(user).where(eq(user.email, email)).for("update");
      if (!owner?.emailVerified || owner.deletedAt || owner.suspendedAt) throw new Error("An active verified existing account is required");
      await tx.update(user).set({ role: "admin", updatedAt: new Date() }).where(eq(user.id, owner.id));
      await tx.delete(session).where(eq(session.userId, owner.id));
      await tx.insert(auditEvents).values({ subjectUserId: owner.id, action: "operator.bootstrap_admin", metadata: {} });
    });
    console.log("Verified account designated. Sign in and complete authenticator setup before administrator access.");
  }
}
main().catch(() => { console.error("Bootstrap failed. Check explicit operator configuration, arguments and account eligibility."); process.exitCode = 1; }).finally(closeDatabase);
