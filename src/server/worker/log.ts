import path from "node:path";
import { open, readdir, stat, unlink } from "node:fs/promises";
import { privateDirectory } from "../recovery/files";
export type OperatorEvent = { code: string; severity: "ok" | "warning" | "critical"; value?: number };
export async function operationalLog(events: OperatorEvent[], root = process.env.OPERATIONS_LOG_ROOT) {
  if (!root) return;
  await privateDirectory(root);
  // Serial CLI/worker writers use O_APPEND; at most 64 KiB overshoot per writer.
  const now = new Date(), name = `${now.toISOString().slice(0, 10)}.jsonl`, target = path.join(root, name);
  const data = events.slice(0, 100).map(e => JSON.stringify({ at: now.toISOString(), code: /^[A-Z_]{2,64}$/.test(e.code) ? e.code : "REDACTED", severity: e.severity, ...(Number.isFinite(e.value) ? { value: e.value } : {}) })).join("\n") + "\n";
  if (Buffer.byteLength(data) > 65536) throw new Error("LOG_RECORD_LIMIT");
  if (await stat(target).then(s => s.size < 10 * 1024 ** 2).catch(() => true)) {
    const f = await open(target, "a", 0o600); try { await f.writeFile(data); await f.sync(); } finally { await f.close(); }
  }
  for (const name of await readdir(root)) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    if (Date.parse(name.slice(0, 10)) < Date.parse(now.toISOString().slice(0, 10)) - 6 * 86400000) await unlink(path.join(root, name));
  }
}
