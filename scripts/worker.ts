import { runWorker } from "../apps/web/lib/server/worker";
import { closeDatabase, database } from "../apps/web/lib/server/db";
import { chainConfig, runtimeKeys } from "../apps/web/lib/server/config";
import { safeLog } from "../apps/web/lib/server/log";

const controller = new AbortController();
let deadline: NodeJS.Timeout | undefined;
function shutdown() {
  if (controller.signal.aborted) return;
  controller.abort();
  // Leave leases recoverable if an external operation cannot finish in time.
  deadline = setTimeout(() => {
    safeLog({ event: "worker.shutdown_timeout", code: "leases_recoverable" });
    process.exit(1);
  }, 110_000);
  deadline.unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
try {
  if (
    process.env.RENDER &&
    Object.keys(process.env).some(
      (name) =>
        process.env[name] && /^(OPERATOR_|DEVNET_TEST_|TEST_MINT_SECRET(?:_FILE)?$)/.test(name),
    )
  )
    throw new Error("Operator keys are forbidden in the Render worker environment");
  chainConfig();
  runtimeKeys();
  if (
    process.env.PAYOUT_PROVIDER !== "mock" ||
    !process.env.MOCK_WEBHOOK_SECRET ||
    process.env.MOCK_WEBHOOK_SECRET.length < 32
  )
    throw new Error("worker_configuration_required");
  await database().query("SELECT name FROM worker_schedules LIMIT 0");
  await runWorker(controller.signal, { pollingMs: Number(process.env.WORKER_POLL_MS ?? "2000") });
} catch {
  safeLog({ event: "worker.failed", code: "check_configuration_and_migrations" });
  process.exitCode = 1;
} finally {
  await closeDatabase();
  if (deadline) clearTimeout(deadline);
  process.removeListener("SIGTERM", shutdown);
  process.removeListener("SIGINT", shutdown);
}
