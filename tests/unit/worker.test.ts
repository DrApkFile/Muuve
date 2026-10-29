import { describe, expect, it, vi } from "vitest";
import { runWorker, retryDelay } from "../../apps/web/lib/server/worker";
describe("continuous worker lifecycle", () => {
  it("polls deliberately and stops accepting work after termination", async () => {
    const c = new AbortController(),
      jobs = vi.fn(async () => {}),
      maintenance = vi.fn(async () => {});
    const delays: number[] = [];
    await runWorker(c.signal, {
      jobs,
      maintenance,
      pause: async (ms) => {
        delays.push(ms);
        c.abort();
      },
    });
    expect(jobs).toHaveBeenCalledTimes(1);
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([2000]);
  });
  it("backs off failures, caps delay, and resets after recovery", async () => {
    const c = new AbortController(),
      delays: number[] = [];
    let calls = 0;
    await runWorker(c.signal, {
      jobs: async () => {
        if (++calls < 3) throw new Error("failure");
      },
      maintenance: async () => {},
      pause: async (ms) => {
        delays.push(ms);
        if (delays.length === 3) c.abort();
      },
    });
    expect(delays).toEqual([4000, 8000, 2000]);
    expect(retryDelay(100)).toBe(30000);
  });
  it("drains current work without starting another task", async () => {
    const c = new AbortController(),
      maintenance = vi.fn(),
      pause = vi.fn();
    await runWorker(c.signal, {
      jobs: async () => {
        c.abort();
      },
      maintenance,
      pause,
    });
    expect(maintenance).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });
  it.each([0, 10, 999, 5001, NaN])("rejects an unsafe polling interval %s", async (pollingMs) => {
    await expect(runWorker(new AbortController().signal, { pollingMs })).rejects.toThrow(
      "worker_poll_interval_invalid",
    );
  });
});
