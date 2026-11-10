import { readdir, readFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { issueInvite } from "../../../src/server/invites";
import { closeDatabase } from "../../../src/server/db";
import { Queue, workerConnection } from "../../../src/server/worker/queue";
import { executeClaim } from "../../../src/server/worker/runtime";
import { dispatch } from "../../../src/server/worker/processor";

// Server-only, not an HTTP debug API. No destructive reset command exists.
if (process.env.E2E_FIXTURE !== "isolated-browser-acceptance" || process.env.SITE_DOMAIN !== "may-be.localhost" ||
    process.env.MAIL_TRANSPORT !== "local" || process.env.MEDIA_STORAGE !== "local" ||
    new URL(process.env.DATABASE_URL!).hostname !== "db" || new URL(process.env.DATABASE_URL!).pathname !== "/browser_acceptance_test") {
  throw new Error("Refusing fixture access outside isolated browser_acceptance_test");
}
const sql = workerConnection();
const [command, arg, extra] = process.argv.slice(2);
let result: unknown;
async function main() { try {
  switch (command) {
    case "invite":
      if (!/^[a-z0-9-]+@example\.invalid$/.test(arg)) throw new Error("Fixture recipient required");
      result = await issueInvite({ email: arg, bootstrap: extra === "admin", expiresInHours: 1 }); break;
    case "mail": {
      const messages = await Promise.all((await readdir(process.env.MAIL_OUTBOX_DIR!)).filter(f => f.endsWith(".json")).map(async f => JSON.parse(await readFile(`${process.env.MAIL_OUTBOX_DIR}/${f}`, "utf8")) as { to: string; text: string }));
      result = messages.filter(m => m.to === arg).map(m => ({ url: m.text.match(/https:\/\/\S+/)?.[0] })); break;
    }
    case "drain": {
      const queue = new Queue(sql); let count = 0;
      for (; count < 200; count++) {
        const claim = await queue.claim(); if (!claim) break;
        // Actual central dispatch and feature processors, in-process for bounded
        // fixture latency. Scheduler/process supervision have separate acceptance.
        await executeClaim(queue, claim, new AbortController().signal, async current => { await dispatch(current); return undefined; });
        const [done] = await sql`select state,last_error_code from jobs where id=${claim.id}`;
        if (done.state !== "succeeded") throw new Error(`Fixture processor failed: ${claim.kind} ${done.last_error_code}`);
      }
      if (count === 200) throw new Error("Fixture drain did not settle");
      result = { processed: count }; break;
    }
    case "state": {
      const [row] = await sql`select u.id, u.deleted_at, p.id as profile_id, p.current_revision_id,
        (select count(*)::int from media where owner_id=u.id) as media_count,
        (select coalesce(sum(views),0)::int from daily_profile_metrics where profile_id=p.id) as views
        from "user" u left join profiles p on p.owner_id=u.id where u.email=${arg}`;
      result = row ?? null; break;
    }
    case "fixtures": {
      const directory = "/tmp/may-be-e2e-fixtures"; await mkdir(directory, { recursive: true });
      await sharp({ create: { width: 96, height: 80, channels: 3, background: "#b45734" } }).png().toFile(`${directory}/image.png`);
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", "-codec:a", "libmp3lame", "-b:a", "96k", "-map_metadata", "-1", `${directory}/tone.mp3`]);
      result = { image: `${directory}/image.png`, audio: `${directory}/tone.mp3` }; break;
    }
    default: throw new Error("Unknown fixture command");
  }
  process.stdout.write(JSON.stringify(result));
} finally { await closeDatabase(); await sql.end({ timeout: 2 }); } }
void main();
