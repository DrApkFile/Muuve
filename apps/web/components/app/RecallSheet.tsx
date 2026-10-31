"use client";

import { useEffect, useState } from "react";
import { api, newIdempotencyKey, type PreparedOperation } from "@/lib/api";
import { isCode, messageFor } from "@/lib/errors";
import { formatUsd } from "@/lib/format";
import { signWithWallet, waitForOperation } from "@/lib/solana";
import { useWallet } from "@/lib/wallet";
import { Button } from "@/components/ui/button";
import { Notice, Sheet, StepProgress, type ProgressStep } from "./kit";
import { WalletGate } from "./WalletGate";
import { announceBalanceChange } from "./FundSheet";

const STEPS: ProgressStep[] = [
  { key: "prepare", label: "Prepare the recall" },
  { key: "sign", label: "Approve in your wallet" },
  { key: "submit", label: "Send it to the network" },
  { key: "confirm", label: "Return the money to your balance" },
];

export type RecallTarget = { slotIndex?: number; who: string; amount: string };

export function RecallSheet({
  linkId,
  target,
  onClose,
  onDone,
}: {
  linkId: string;
  target: RecallTarget | null;
  onClose(): void;
  onDone(): void;
}) {
  const wallet = useWallet();
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [op, setOp] = useState<PreparedOperation | null>(null);
  const [signed, setSigned] = useState<{ tx: string; key: string } | null>(null);

  useEffect(() => {
    if (target) {
      setStep(null);
      setError(null);
      setOp(null);
      setSigned(null);
    }
  }, [target]);

  async function run() {
    if (!target) return;
    setError(null);
    try {
      let operation = op;
      if (!operation) {
        setStep("prepare");
        operation = await api<PreparedOperation>(
          `/api/links/${linkId}/recall/prepare`,
          target.slotIndex === undefined ? {} : { slot_index: target.slotIndex },
        );
        setOp(operation);
      }
      let sig = signed;
      if (!sig) {
        setStep("sign");
        const latest = await api<PreparedOperation & { state: string }>(
          `/api/operations/${operation.operation_id}`,
        ).catch(() => operation!);
        sig = {
          tx: await signWithWallet(latest.tx, wallet.signTransaction),
          key: newIdempotencyKey(),
        };
        setSigned(sig);
      }
      setStep("submit");
      await api(`/api/links/${linkId}/recall/submit`, {
        operation_id: operation.operation_id,
        tx: sig.tx,
        idempotency_key: sig.key,
      });
      setStep("confirm");
      const state = await waitForOperation(operation.operation_id);
      if (state === "finalized") {
        setStep("done");
        announceBalanceChange();
        onDone();
        return;
      }
      setError(
        state === "failed"
          ? "The recall didn't go through. The money is still waiting for them."
          : "Still confirming. This page will update when it's done.",
      );
      if (state === "failed") {
        setOp(null);
        setSigned(null);
      }
    } catch (err) {
      if (
        isCode(
          err,
          "transaction_message_mismatch",
          "invalid_transaction_signatures",
          "attempt_no_longer_submittable",
        )
      )
        setSigned(null);
      setError(messageFor(err));
    }
  }

  const busy = step !== null && step !== "done" && !error;
  return (
    <Sheet
      open={!!target}
      onClose={onClose}
      title={target?.slotIndex === undefined ? "Recall all unclaimed" : "Recall this payment"}
      dismissible={!busy}
    >
      {target && (
        <div className="flex flex-col gap-5">
          {step === null ? (
            <>
              <p className="m-0 text-ink/65">
                {formatUsd(target.amount, { cents: true })} comes back to your balance now, and{" "}
                {target.who} will see that you cancelled it. You can&apos;t undo this.
              </p>
              <WalletGate purpose="to recall">
                <Button variant="danger" size="lg" onClick={run}>
                  Recall {formatUsd(target.amount, { cents: true })}
                </Button>
              </WalletGate>
            </>
          ) : step === "done" ? (
            <>
              <Notice tone="sage">
                {formatUsd(target.amount, { cents: true })} is back in your balance.
              </Notice>
              <Button onClick={onClose}>Done</Button>
            </>
          ) : (
            <>
              <StepProgress steps={STEPS} current={step} failed={!!error} />
              {error && (
                <>
                  <Notice tone="danger">{error}</Notice>
                  <div className="flex gap-2">
                    <Button onClick={run}>Try again</Button>
                    <Button variant="ghost" onClick={onClose}>
                      Close
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}
