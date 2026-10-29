import { database, one } from "./db";
import { Chain } from "./solana/chain";
import { safeLog } from "./log";
export async function monitor(chain = new Chain()) {
  const counts = await one(`SELECT
 (SELECT count(*) FROM operations WHERE state='unknown') AS unknown_operations,
 (SELECT count(*) FROM principals WHERE state='quarantined') AS quarantined_principals,
 (SELECT count(*) FROM jobs WHERE state='quarantined') AS quarantined_jobs,
 (SELECT count(*) FROM links WHERE status='open' AND expires_at<now()-interval '5 minutes' AND EXISTS(SELECT 1 FROM link_slots s WHERE s.link_id=links.id AND s.status='funded')) AS overdue_expiry,
 (SELECT count(*) FROM payouts WHERE status='processing' AND updated_at<now()-interval '5 minutes') AS slow_payouts`);
  for (const [code, n] of Object.entries(counts ?? {}))
    if (BigInt(n) > 0n) safeLog({ event: "monitor.alert", code });
  const liabilities = (
    await database().query(
      "SELECT treasury_owner,sum(amount_base_units)::text AS amount FROM principals WHERE state IN ('treasury','resolving','quarantined') GROUP BY treasury_owner",
    )
  ).rows;
  const deficits = [];
  for (const row of liabilities) {
    if (!row.treasury_owner) {
      deficits.push({ code: "unknown_treasury_origin" });
      continue;
    }
    const available = await chain.balance(row.treasury_owner);
    if (BigInt(available) < BigInt(row.amount))
      deficits.push({
        code: "treasury_deficit",
        treasury_owner: row.treasury_owner,
        liability: row.amount,
        available,
      });
  }
  const feePayerLamports = await chain.rpc((c) =>
    c.getBalance(chain.keys.payer.publicKey, "finalized"),
  );
  if (feePayerLamports < 1_000_000_000) safeLog({ event: "monitor.alert", code: "fee_payer_low" });
  for (const deficit of deficits) safeLog({ event: "monitor.alert", code: deficit.code });
  return { counts, deficits, fee_payer_lamports: feePayerLamports };
}
