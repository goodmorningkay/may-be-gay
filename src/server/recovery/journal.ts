import { createReadStream } from "node:fs";
import { recoveryRecordSchema } from "../operations/recovery";
import { fail } from "./files";
/** Bound incomplete lines while streaming, before JSON parsing/allocation. */
export async function* journalRecords(file: string) {
  let pending = "", previous = 0, count = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 65536, encoding: "utf8" })) {
    pending += chunk;
    for (;;) {
      const i = pending.indexOf("\n"); if (i < 0) break;
      if (i > 8192) fail("JOURNAL_RECORD_LIMIT");
      const event = recoveryRecordSchema.parse(JSON.parse(pending.slice(0, i))); pending = pending.slice(i + 1);
      if (event.sequence <= previous || ++count > 1000000) fail("JOURNAL_ORDER_INVALID");
      previous = event.sequence; yield event;
    }
    if (pending.length > 8192) fail("JOURNAL_RECORD_LIMIT");
  }
  if (pending) fail("JOURNAL_TRUNCATED");
}
