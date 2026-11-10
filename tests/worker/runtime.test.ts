import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorker } from "../../src/server/worker/runtime";
import { runProcessor } from "../../src/server/worker/process";
import { archiveSchedule } from "../../src/server/worker/schedules";
import type { Queue } from "../../src/server/worker/queue";

vi.mock("../../src/server/worker/process", () => ({ runProcessor: vi.fn() }));
vi.mock("../../src/server/worker/schedules", () => ({ archiveSchedule: vi.fn(async () => {}) }));
vi.mock("../../src/server/worker/maintenance", () => ({ readiness: () => ({ backup: true }) }));
vi.mock("../../src/server/service-state", () => ({ serviceState: async () => "open" }));

afterEach(() => vi.useRealTimers());
describe("one-job worker mode", () => {
  it("does not schedule archives while a selected job takes longer than the timer interval", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const job = new Promise<undefined>(resolve => { release = () => resolve(undefined); });
    vi.mocked(runProcessor).mockImplementation((_claim, _signal, _timeout, entry) => entry ? Promise.resolve(undefined) : job);
    const queue = { sql: vi.fn(async () => []), reclaim: vi.fn(async () => {}),
      claim: vi.fn(async () => ({ kind: "media", created_at: new Date() })),
      renew: vi.fn(async () => true), finish: vi.fn(async () => true) } as unknown as Queue;
    const running = runWorker(queue, new AbortController().signal, true);
    try {
      await vi.advanceTimersByTimeAsync(20001);
      expect(queue.claim).toHaveBeenCalledTimes(1);
      expect(archiveSchedule).not.toHaveBeenCalled();
    } finally { release(); await running; }
  });
});
