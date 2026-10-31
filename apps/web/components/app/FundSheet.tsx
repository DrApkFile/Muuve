"use client";

import { useEffect, useState } from "react";
import { api, newIdempotencyKey } from "@/lib/api";
import { messageFor } from "@/lib/errors";
import { formatUsd } from "@/lib/format";
import { waitForOperation } from "@/lib/solana";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Notice, Sheet, Spinner } from "./kit";

const AMOUNTS = ["25000000", "50000000", "100000000", "200000000"];

export const BALANCE_EVENT = "muuve:balance-changed";
export const announceBalanceChange = () => window.dispatchEvent(new Event(BALANCE_EVENT));

export function FundSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const { user } = useSession();
  const [amount, setAmount] = useState(AMOUNTS[1]!);
  const [key, setKey] = useState(newIdempotencyKey);
  const [phase, setPhase] = useState<"idle" | "working" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const cleva = user?.auth_origin === "cleva_preview";

  // A new amount is a new request; keep the key stable for retries of the same one.
  useEffect(() => setKey(newIdempotencyKey()), [amount]);
  useEffect(() => {
    if (open) {
      setPhase("idle");
      setError(null);
    }
  }, [open]);

  async function addMoney() {
    setPhase("working");
    setError(null);
    try {
      const res = await api<{ operation_id: string }>(
        cleva ? "/api/fund/cleva-preview" : "/api/fund/demo",
        { amount_base_units: amount },
        { headers: { "idempotency-key": key } },
      );
      const state = await waitForOperation(res.operation_id);
      if (state === "failed") throw new Error("funding_failed");
      if (state !== "finalized") {
        setError("Still confirming. Your balance will update shortly.");
        setPhase("idle");
        announceBalanceChange();
        return;
      }
      setPhase("done");
      setKey(newIdempotencyKey());
      announceBalanceChange();
    } catch (err) {
      setError(
        err instanceof Error && err.message === "funding_failed"
          ? "That didn't go through. Nothing was added. Try again."
          : messageFor(err),
      );
      setPhase("idle");
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={cleva ? "Fund from Cleva balance" : "Add test dollars"}
      dismissible={phase !== "working"}
    >
      {phase === "done" ? (
        <div className="flex flex-col gap-5">
          <Notice tone="sage">
            <strong className="font-semibold">{formatUsd(amount)}</strong> added to your balance.
          </Notice>
          <Button onClick={onClose}>Done</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <p className="m-0 text-sm text-ink/60">
            {cleva
              ? "Partnership preview: this adds demo dollars labelled as your Cleva balance."
              : "This is a demo. Test dollars have no real value, up to $200 a day."}
          </p>
          <div role="radiogroup" aria-label="Amount" className="grid grid-cols-4 gap-2">
            {AMOUNTS.map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={amount === a}
                onClick={() => setAmount(a)}
                disabled={phase === "working"}
                className={
                  amount === a
                    ? "h-14 rounded-2xl bg-ink text-[17px] font-medium text-cream"
                    : "h-14 rounded-2xl border border-ink/10 bg-paper text-[17px] font-medium hover:border-ink/30"
                }
              >
                {formatUsd(a)}
              </button>
            ))}
          </div>
          {error && (
            <Notice tone="danger" className="m-0">
              {error}
            </Notice>
          )}
          <Button size="lg" onClick={addMoney} disabled={phase === "working"}>
            {phase === "working" ? (
              <>
                <Spinner /> Adding {formatUsd(amount)}…
              </>
            ) : (
              `Add ${formatUsd(amount)}`
            )}
          </Button>
        </div>
      )}
    </Sheet>
  );
}
