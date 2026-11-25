import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorker } from "../../src/server/worker/runtime";
import { dispatch } from "../../src/server/worker/processor";
import { archiveSchedule } from "../../src/server/worker/schedules";
import { maintain } from "../../src/server/worker/maintenance";
import type { Queue } from "../../src/server/worker/queue";

vi.mock("../../src/server/worker/processor", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/server/worker/processor")>();
  return { ...actual, dispatch: vi.fn() };
});
vi.mock("../../src/server/worker/schedules", () => ({ archiveSchedule: vi.fn(async () => {}) }));
vi.mock("../../src/server/worker/maintenance", () => ({
  readiness: () => ({ backup: true }),
  maintain: vi.fn(async () => {}),
}));
vi.mock("../../src/server/service-state", () => ({ serviceState: async () => "open" }));

afterEach(() => vi.useRealTimers());

describe("one-job worker mode", () => {
  it("does not schedule archives while a selected job takes longer than the timer interval", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const job = new Promise<void>(resolve => {
      release = () => resolve();
    });
    vi.mocked(dispatch).mockImplementation(() => job);
    const sql = Object.assign(vi.fn(async () => []), {
      json: (v: unknown) => v,
    });
    const queue = {
      sql,
      reclaim: vi.fn(async () => {}),
      claim: vi.fn(async () => ({ kind: "media", payload_version: 1, created_at: new Date() })),
      renew: vi.fn(async () => true),
      finish: vi.fn(async () => true),
    } as unknown as Queue;
    const running = runWorker(queue, new AbortController().signal, true);
    try {
      await vi.advanceTimersByTimeAsync(20001);
      expect(maintain).toHaveBeenCalledTimes(1);
      expect(queue.claim).toHaveBeenCalledTimes(1);
      expect(archiveSchedule).not.toHaveBeenCalled();
    } finally {
      release();
      await running;
    }
  });
});

it("keeps a media claim unstarted during a snapshot longer than the job deadline", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const snapshot = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(archiveSchedule).mockImplementation(async (_, kind) => {
    if (kind === "snapshot") await snapshot;
  });
  const stop = new AbortController();
  const queue = {
    sql: Object.assign(vi.fn(async () => []), { json: (v: unknown) => v }),
    reclaim: vi.fn(async () => {}),
    claim: vi.fn(async () => ({ kind: "media", created_at: new Date() })),
    finish: vi.fn(async () => { stop.abort(); return true; }),
  } as unknown as Queue;
  vi.mocked(dispatch).mockResolvedValue(undefined);
  const running = runWorker(queue, stop.signal);
  try {
    await vi.advanceTimersByTimeAsync(61_000);
    expect(archiveSchedule).toHaveBeenCalledWith(queue.sql, "snapshot", expect.any(AbortSignal));
    expect(queue.claim).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.finish).toHaveBeenCalledOnce();
  } finally {
    release();
    stop.abort();
    await running;
  }
});
