import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { one, transaction } from "./db";
import { runJobs, reconcileAll, expireLinks, failedPayouts } from "./jobs";
import { monitor } from "./monitor";
import { safeLog } from "./log";

export type WorkerTask = "reconcile" | "expire" | "failed_payouts" | "monitor";
export const taskIntervals: Record<WorkerTask, number> = {
  reconcile: 300_000,
  expire: 300_000,
  failed_payouts: 900_000,
  monitor: 60_000,
};
export async function maintenanceTask(
  name: WorkerTask,
  action: () => Promise<unknown>,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return false;
  const token = randomUUID();
  const leased = await transaction(async (c) => {
    await c.query("INSERT INTO worker_schedules(name) VALUES($1) ON CONFLICT DO NOTHING", [name]);
    return one(
      `UPDATE worker_schedules SET lease_token=$2,lease_until=now()+interval '60 seconds'
      WHERE name=$1 AND next_run_at<=now() AND (lease_until IS NULL OR lease_until<now()) RETURNING name`,
      [name, token],
      c,
    );
  });
  if (!leased) return false;
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void transaction((c) =>
      c.query(
        "UPDATE worker_schedules SET lease_until=now()+interval '60 seconds' WHERE name=$1 AND lease_token=$2",
        [name, token],
      ),
    )
      .catch(() => safeLog({ event: "worker.lease_renewal_failed", code: name }))
      .finally(() => {
        renewing = false;
      });
  }, 15_000);
  heartbeat.unref();
  let succeeded = false;
  try {
    await action();
    succeeded = true;
    safeLog({ event: "worker.task_completed", code: name });
    return true;
  } finally {
    clearInterval(heartbeat);
    await transaction((c) =>
      c.query(
        `UPDATE worker_schedules SET lease_until=NULL,lease_token=NULL,
      next_run_at=now()+$3*interval '1 millisecond' WHERE name=$1 AND lease_token=$2`,
        [name, token, succeeded ? taskIntervals[name] : 30_000],
      ),
    );
  }
}
export function retryDelay(failures: number, pollingMs = 2000) {
  return Math.min(30_000, pollingMs * 2 ** Math.min(failures, 10));
}
export async function runWorker(
  signal: AbortSignal,
  options: {
    pollingMs?: number;
    jobs?: (options: { signal: AbortSignal }) => Promise<unknown>;
    maintenance?: (signal: AbortSignal) => Promise<unknown>;
    pause?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const pollingMs = options.pollingMs ?? 2000;
  if (!Number.isInteger(pollingMs) || pollingMs < 1000 || pollingMs > 5000)
    throw new Error("worker_poll_interval_invalid");
  const jobs = options.jobs ?? runJobs;
  const maintenance =
    options.maintenance ??
    (async (s) => {
      for (const [name, action] of Object.entries({
        reconcile: () => reconcileAll(undefined, { signal: s }),
        expire: () => expireLinks(undefined, { signal: s }),
        failed_payouts: () => failedPayouts({ signal: s }),
        monitor,
      })) {
        if (s.aborted) break;
        try {
          await maintenanceTask(name as WorkerTask, () => action(), s);
        } catch {
          safeLog({ event: "worker.maintenance_deferred", code: name });
        }
      }
    });
  const pause =
    options.pause ??
    (async (ms, s) => {
      await sleep(ms, undefined, { signal: s });
    });
  let failures = 0;
  let maintenanceInFlight: Promise<void> | undefined;
  safeLog({ event: "worker.started", code: "devnet_mock_payouts" });
  while (!signal.aborted) {
    try {
      await jobs({ signal });
      if (!signal.aborted && !maintenanceInFlight) {
        maintenanceInFlight = maintenance(signal)
          .then(() => {})
          .catch(() => safeLog({ event: "worker.maintenance_deferred", code: "retry_required" }))
          .finally(() => {
            maintenanceInFlight = undefined;
          });
      }
      failures = 0;
    } catch {
      failures++;
      safeLog({ event: "worker.cycle_failed", code: "retry_required" });
    }
    if (signal.aborted) break;
    try {
      await pause(retryDelay(failures, pollingMs), signal);
    } catch {
      if (!signal.aborted) throw new Error("worker_pause_failed");
    }
  }
  await maintenanceInFlight;
  safeLog({ event: "worker.stopped" });
}
