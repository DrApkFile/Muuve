import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import { runWorker } from "../apps/web/lib/server/worker";
import { runJobs } from "../apps/web/lib/server/jobs";
import { database, closeDatabase } from "../apps/web/lib/server/db";
import { PublicKey } from "@solana/web3.js";
import { operatorConnection } from "./operator";
import { decodeLink } from "../apps/web/lib/server/solana/codec";

// The existing worker engine and job handlers, restricted to one approved mock
// payout. No global maintenance, expiry, refunds or replacement submissions.
const role = process.argv.find((arg) => /^--role=(a|b|retry-b)$/.test(arg))?.slice(7),
  evidence: Record<string, any> = {
    started_at: new Date().toISOString(),
    role,
    scope: "Local scoped worker against hosted Supabase; mock payouts only",
    transactions_submitted: 0,
  },
  stop = new AbortController();
let deadline: ReturnType<typeof setTimeout> | undefined;
function assert(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function terminate() {
  evidence.termination_signal_received = true;
  stop.abort();
}
try {
  assert(
    role &&
      process.argv.includes("--operator-approved-test-budget") &&
      process.env.OPERATOR_APPROVED_DEVNET === "1" &&
      process.env.MUUVE_RUN_DEVNET_TRANSACTIONS === "1",
    "approved_scoped_mock_worker_required",
  );
  const local = parseEnv(await readFile(".env.local", "utf8")),
    api = parseEnv(await readFile(".env.render-api", "utf8")),
    worker = parseEnv(await readFile(".env.render-worker", "utf8")),
    progress = JSON.parse(
      await readFile(
        process.argv.includes("--replacement-recipient")
          ? "keys/replacement-payment-run.json"
          : "keys/backend-payment-run.json",
        "utf8",
      ),
    ),
    fixture = progress.fixtures.main,
    entry = progress.roles[role === "a" ? "a" : "b"],
    payoutId = role === "retry-b" ? entry.retry_payout_id : entry.payout?.payout?.id;
  assert(payoutId && entry.state === "treasury_claim_finalized", "actual_finalized_claim_required");
  const target = new URL(local.DATABASE_URL!);
  assert(
    target.hostname === "aws-0-eu-west-1.pooler.supabase.com" &&
      decodeURIComponent(target.username) === "postgres.yirelxmcveyxcqofzayq" &&
      target.port === "5432" &&
      target.pathname === "/postgres" &&
      target.searchParams.get("sslmode") === "verify-full",
    "intended_hosted_database_required",
  );
  for (const env of [api, worker]) {
    const url = new URL(env.DATABASE_URL!);
    assert(
      url.hostname === target.hostname &&
        url.username === target.username &&
        url.password === target.password &&
        url.port === target.port &&
        url.pathname === target.pathname &&
        env.SOLANA_CLUSTER === "devnet" &&
        env.PAYOUT_PROVIDER === "mock" &&
        env.MOCK_WEBHOOK_SECRET === local.MOCK_WEBHOOK_SECRET,
      "api_worker_target_or_secret_mismatch",
    );
  }
  assert(
    local.SOLANA_CLUSTER === "devnet" &&
      local.PAYOUT_PROVIDER === "mock" &&
      api.APP_BASE_URL === "https://muuve.onrender.com",
    "intended_api_devnet_mock_required",
  );
  // Only values needed by the selected job handlers are assigned. The CA path
  // comes from the verified local URL, never Render's /etc/secrets path.
  Object.assign(process.env, {
    DATABASE_URL: local.DATABASE_URL,
    SOLANA_CLUSTER: "devnet",
    PAYOUT_PROVIDER: "mock",
    MOCK_WEBHOOK_SECRET: worker.MOCK_WEBHOOK_SECRET,
    SOLANA_RPC_URL: local.SOLANA_RPC_URL,
  });
  const payout = (
    await database().query(
      `SELECT p.id,p.status,p.retry_of,p.provider,r.id AS principal_id,r.amount_base_units,r.treasury_account,r.treasury_owner,r.state AS principal_state,s.link_id,s.slot_index,s.recipient_phone_e164
    FROM payouts p JOIN principals r ON r.id=p.principal_id JOIN link_slots s ON s.id=r.link_slot_id WHERE p.id=$1`,
      [payoutId],
    )
  ).rows[0];
  const index = role === "a" ? 0 : 1;
  assert(
    payout?.provider === "mock" &&
      payout.link_id === fixture.id &&
      payout.slot_index === index &&
      payout.recipient_phone_e164 === entry.phone &&
      payout.amount_base_units === fixture.amounts[index] &&
      payout.treasury_account === api.TREASURY_TOKEN_ACCOUNT,
    "payout_outside_approved_fixture",
  );
  const root = payout.retry_of ?? payout.id;
  const operation = (
    await database().query(
      "SELECT o.id,o.state,a.signature FROM operations o JOIN transaction_attempts a ON a.operation_id=o.id WHERE o.payout_id=$1 AND o.kind='claim_cashout' ORDER BY a.created_at DESC LIMIT 1",
      [root],
    )
  ).rows[0];
  assert(operation?.state === "finalized", "finalized_treasury_operation_required");
  const connection = await operatorConnection(),
    status = (
      await connection.getSignatureStatuses([operation.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
  assert(
    status?.confirmationStatus === "finalized" && !status.err,
    "successful_finalized_chain_receipt_required",
  );
  const receipt = await connection.getTransaction(operation.signature, {
    commitment: "finalized",
    maxSupportedTransactionVersion: 0,
  });
  assert(receipt?.meta && !receipt.meta.err, "successful_chain_transaction_required");
  const keys = receipt.transaction.message.getAccountKeys(),
    treasuryIndex = Array.from({ length: keys.length }, (_, i) => keys.get(i)?.toBase58()).indexOf(
      payout.treasury_account,
    );
  const before = receipt.meta.preTokenBalances?.find((b) => b.accountIndex === treasuryIndex),
    after = receipt.meta.postTokenBalances?.find((b) => b.accountIndex === treasuryIndex);
  assert(
    treasuryIndex >= 0 &&
      before &&
      after &&
      before?.mint === api.USDT_MINT &&
      after?.mint === api.USDT_MINT &&
      after.owner === payout.treasury_owner &&
      BigInt(after.uiTokenAmount.amount) - BigInt(before.uiTokenAmount.amount) ===
        BigInt(payout.amount_base_units),
    "exact_treasury_receipt_not_verified",
  );
  const account = await connection.getAccountInfo(new PublicKey(fixture.pda), "finalized");
  assert(account && account.owner.toBase58() === api.MUUVE_PROGRAM_ID, "link_owner_mismatch");
  const link = decodeLink(account.data);
  assert(
    link.slots[index]?.status === 2 && link.slots[index]?.amount === payout.amount_base_units,
    "claimed_slot_chain_state_required",
  );
  evidence.payout_id = payout.id;
  evidence.principal_id = payout.principal_id;
  evidence.finalized_treasury_signature = operation.signature;
  evidence.expected_status = role === "b" ? "failed" : "paid";
  const starting = (
    await database().query(
      "SELECT id,state,attempts FROM jobs WHERE entity_id=$1 ORDER BY created_at",
      [payout.id],
    )
  ).rows;
  evidence.jobs_before = starting;
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  deadline = setTimeout(() => {
    evidence.deadline_reached = true;
    stop.abort();
  }, 120000);
  await runWorker(stop.signal, {
    pollingMs: 1000,
    maintenance: async () => {},
    jobs: async ({ signal }) => {
      await runJobs({ signal, maxJobs: 4, payoutIds: [payout.id] });
      const row = (await database().query("SELECT status FROM payouts WHERE id=$1", [payout.id]))
        .rows[0];
      if (["paid", "failed", "resolved", "quarantined"].includes(row?.status)) {
        evidence.observed_status = row.status;
        process.kill(process.pid, "SIGTERM");
      }
    },
  });
  const result = (
    await database().query(
      "SELECT p.id,p.status,r.state AS principal_state,s.status AS slot_state FROM payouts p JOIN principals r ON r.id=p.principal_id JOIN link_slots s ON s.id=r.link_slot_id WHERE p.id=$1",
      [payout.id],
    )
  ).rows[0];
  assert(result?.status === evidence.expected_status, "expected_mock_payout_outcome_not_reached");
  evidence.result = result;
  evidence.jobs_after = (
    await database().query(
      "SELECT id,kind,state,attempts FROM jobs WHERE entity_id=$1 ORDER BY created_at",
      [payout.id],
    )
  ).rows;
  evidence.transfer_count = Number(
    (
      await database().query("SELECT count(*) FROM mock_provider_transfers WHERE payout_id=$1", [
        payout.id,
      ])
    ).rows[0].count,
  );
  evidence.webhook_count = Number(
    (await database().query("SELECT count(*) FROM webhook_inbox WHERE payout_id=$1", [payout.id]))
      .rows[0].count,
  );
  assert(
    evidence.transfer_count === 1 && evidence.webhook_count === 1,
    "single_mock_transfer_and_webhook_required",
  );
  evidence.state = "passed_scoped_hosted_mock_payout_worker";
} catch (error) {
  evidence.state = "blocked_or_failed_reconcile_before_retry";
  evidence.code =
    error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : "scoped_worker_configuration_or_transport_failure";
  process.exitCode = 1;
} finally {
  if (deadline) clearTimeout(deadline);
  stop.abort();
  process.removeListener("SIGTERM", terminate);
  process.removeListener("SIGINT", terminate);
  await closeDatabase();
  await mkdir("evidence/backend-payment", { recursive: true });
  const path = `evidence/backend-payment/scoped-worker-${randomUUID()}.json`;
  evidence.finished_at = new Date().toISOString();
  await writeFile(path, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  console.info(JSON.stringify({ state: evidence.state, code: evidence.code, evidence: path }));
}
