import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runProcessor } from "../../src/server/worker/process";
import { failureCode } from "../../src/server/worker/errors";
import { certificateDays, deliverAlerts } from "../../src/server/worker/checks";
import type { Claim } from "../../src/server/worker/queue";
import { compileGuardian } from "./native-supervision-fixture";
describe("bounded subprocesses and redaction", () => {
  let guardian: Awaited<ReturnType<typeof compileGuardian>>;
  beforeAll(async () => { guardian = await compileGuardian(); vi.stubEnv("NATIVE_GUARDIAN_BIN", guardian.binary); });
  afterAll(async () => { vi.unstubAllEnvs(); await guardian?.dispose(); });
  it("kills the side-effect process on deadline, waits for exit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "worker-test-"));
    try {
      const entry = path.join(root, "hang.cjs"), marker = path.join(root, "late");
      await writeFile(entry, `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'),1000);setInterval(()=>{},50);`);
      expect(await runProcessor({} as Claim, new AbortController().signal, 100, entry)).toBe("PROCESSOR_TIMEOUT");
      const { existsSync } = await import("node:fs"); expect(existsSync(marker)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("preserves processor claim stdin and successful result IPC through the guardian", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "worker-test-"));
    try {
      const entry = path.join(root, "result.cjs");
      await writeFile(entry, `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{process.send({code:JSON.parse(input).kind==='email'?'OK':'INVALID'});process.disconnect();});`);
      expect(await runProcessor({ kind: "email" } as Claim, new AbortController().signal, 5000, entry)).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("does not expose raw provider messages, tokens, payloads", () => {
    expect(failureCode(new Error("secret token private/key email@example.invalid"))).toBe("PROCESSOR_FAILED");
    expect(failureCode({ code: "MEDIA_STORAGE_UNAVAILABLE", message: "secret" })).toBe("MEDIA_STORAGE_UNAVAILABLE");
  });
  it("rejects unbounded certificate targets and gates live alerts", async () => {
    await expect(certificateDays("127.0.0.1")).rejects.toThrow("CERTIFICATE_TARGET_INVALID");
    process.env.OPERATIONS_ALERT_TRANSPORT = "slack"; delete process.env.OPERATIONS_ALLOW_LIVE_ALERTS;
    await expect(deliverAlerts([])).rejects.toThrow("LIVE_ALERTS_DISABLED"); delete process.env.OPERATIONS_ALERT_TRANSPORT;
  });
});
