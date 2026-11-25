import { afterEach, describe, expect, it, vi } from "vitest";
import { executeClaim, runInProcess } from "../../src/server/worker/runtime";
import { failureCode } from "../../src/server/worker/processor";
import type { Claim, Queue } from "../../src/server/worker/queue";
import * as processor from "../../src/server/worker/processor";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("in-process worker bounds and redaction", () => {
  it("leaves the claim leased when an in-process job times out", async () => {
    vi.useFakeTimers();
    const dispatch = vi.spyOn(processor, "dispatch").mockImplementation(() => new Promise(() => {}));
    const queue = { finish: vi.fn() } as unknown as Queue;
    const running = executeClaim(queue, { kind: "media" } as Claim, new AbortController().signal,
      (claim, signal) => runInProcess(claim, signal, undefined, 100));
    const interrupted = expect(running).rejects.toThrow("PROCESSOR_TIMEOUT");
    await vi.advanceTimersByTimeAsync(101);
    await interrupted;
    expect(dispatch).toHaveBeenCalledOnce();
    expect(queue.finish).not.toHaveBeenCalled();
  });

  it("aborts an in-process job on signal and skips queue.finish in executeClaim", async () => {
    const abort = new AbortController();
    const queue = {
      sql: {},
      renew: vi.fn(async () => true),
      finish: vi.fn(async () => true),
    } as unknown as Queue;

    const running = executeClaim(
      queue,
      { kind: "media", created_at: new Date() } as Claim,
      abort.signal,
      async (_claim, signal) => {
        abort.abort();
        expect(signal.aborted).toBe(true);
        return "LEASE_LOST_OR_SHUTDOWN";
      },
    );

    await expect(running).rejects.toThrow("WORKER_SHUTDOWN");
    expect(queue.finish).not.toHaveBeenCalled();
  });

  it("does not expose raw provider messages, tokens, or payloads", () => {
    expect(failureCode(new Error("secret token private/key email@example.invalid"))).toBe("PROCESSOR_FAILED");
    expect(failureCode({ code: "MEDIA_STORAGE_UNAVAILABLE", message: "secret" })).toBe("MEDIA_STORAGE_UNAVAILABLE");
    expect(failureCode(Object.assign(new Error("bad payload"), { name: "ZodError" }))).toBe("INVALID_JOB_PAYLOAD");
  });
});
