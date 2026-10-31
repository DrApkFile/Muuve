import { api, type Payout } from "./api";

const DONE = new Set(["paid", "failed", "resolved", "quarantined"]);

/** Polls a payout every ~2s until it reaches a terminal (or needs-review) state. */
export async function waitForPayout(
  id: string,
  onUpdate: (p: Payout) => void,
  signal?: AbortSignal,
  timeoutMs = 180_000,
): Promise<Payout | null> {
  const started = Date.now();
  let last: Payout | null = null;
  while (!signal?.aborted && Date.now() - started < timeoutMs) {
    try {
      const { payout } = await api<{ payout: Payout }>(`/api/payouts/${id}`, undefined, { signal });
      last = payout;
      onUpdate(payout);
      if (DONE.has(payout.status)) return payout;
    } catch {
      if (signal?.aborted) break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}
