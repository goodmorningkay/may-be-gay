import { closeDatabase } from "../src/server/db";
import { runRecordedArchive } from "../src/server/worker/schedules";

const kind = process.argv.includes("--journal") ? "journal" : "snapshot";
const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
process.once("SIGINT", () => stop.abort());

async function main() {
  try {
    const result = await runRecordedArchive(kind, stop.signal);
    console.log(JSON.stringify(result));
  } catch {
    console.error('{"code":"ARCHIVE_FAILED"}');
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

void main().catch(() => {
  console.error('{"code":"ARCHIVE_FAILED"}');
  process.exitCode = 1;
});
