"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Divide, Minus, Plus, Trash2, Users, UserRound } from "lucide-react";
import { LIMITS } from "@muuve/shared";
import { api, newIdempotencyKey, type LinkDetail, type PreparedOperation } from "@/lib/api";
import { isCode, messageFor } from "@/lib/errors";
import { formatUsd, parseUsd, randomHex, splitEqually, usdInput } from "@/lib/format";
import { useBalance } from "@/lib/hooks";
import {
  claimKeyFromSignature,
  claimMessage,
  rememberClaimSecret,
  signWithWallet,
  waitForOperation,
} from "@/lib/solana";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  Field,
  Notice,
  Sheet,
  StepProgress,
  inputClass,
  type ProgressStep,
} from "@/components/app/kit";
import { PhoneInput, toE164, type PhoneValue } from "@/components/app/PhoneInput";
import { GlassLens } from "@/components/app/GlassLens";
import { TintedIcon } from "@/components/app/TintedIcon";
import { WalletGate } from "@/components/app/WalletGate";

type Row = { id: string; phone: PhoneValue; amount: string; label: string };
const newRow = (): Row => ({
  id: randomHex(6),
  phone: { country: "NG", number: "" },
  amount: "",
  label: "",
});

const STEPS: ProgressStep[] = [
  { key: "key", label: "Create the link's private key in your wallet" },
  { key: "prepare", label: "Lock in recipients and amounts" },
  { key: "sign", label: "Approve the payment in your wallet" },
  { key: "submit", label: "Send it to the network" },
  { key: "confirm", label: "Confirm the money is held safely" },
];

/** Our own user-facing messages, as opposed to API/wallet errors mapped by messageFor. */
class FlowError extends Error {}

/** Everything needed to retry the same payment without creating a second one. */
type Draft = {
  linkIdHex: string;
  claim?: { publicKey: string; secret: string };
  body?: unknown;
  linkId?: string;
  operation?: PreparedOperation;
  signed?: { tx: string; key: string };
};

export default function SendPage() {
  const router = useRouter();
  const wallet = useWallet();
  const balance = useBalance();
  const [batch, setBatch] = useState(false);
  const [rows, setRows] = useState<Row[]>([newRow()]);
  const [note, setNote] = useState("");
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitTotal, setSplitTotal] = useState("");
  const [touched, setTouched] = useState(false);
  const [flowOpen, setFlowOpen] = useState(false);
  const [step, setStep] = useState("key");
  const [flowError, setFlowError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("mode") === "batch") {
      setBatch(true);
      setRows([newRow(), newRow(), newRow()]);
    }
  }, []);

  const setCount = (n: number) =>
    setRows((current) => {
      const next = current.slice(0, n);
      while (next.length < n) next.push(newRow());
      return next;
    });

  const switchMode = (toBatch: boolean) => {
    setBatch(toBatch);
    setCount(toBatch ? Math.max(rows.length, 2) : 1);
  };

  // ---------- Validation (client-side only; the server and chain check again) ----------
  const checked = useMemo(() => {
    const phones = rows.map((r) => toE164(r.phone));
    const amounts = rows.map((r) => parseUsd(r.amount));
    const seen = new Map<string, number>();
    phones.forEach((p) => p && seen.set(p, (seen.get(p) ?? 0) + 1));
    const errors = rows.map((r, i) => ({
      phone: !r.phone.number
        ? "Enter their number"
        : !phones[i]
          ? "That number doesn't look right"
          : seen.get(phones[i]!)! > 1
            ? "This number is already on the list"
            : null,
      amount: !r.amount
        ? "Enter an amount"
        : !amounts[i]
          ? "Enter an amount like 50 or 12.50"
          : BigInt(amounts[i]!) > LIMITS.maxSlot
            ? `Up to ${formatUsd(LIMITS.maxSlot)} per person`
            : null,
    }));
    const total = amounts.reduce((s, a) => s + (a ? BigInt(a) : 0n), 0n);
    const bal = balance.data ? BigInt(balance.data.amount_base_units) : null;
    const totalError =
      total > LIMITS.maxLink
        ? `One link can hold up to ${formatUsd(LIMITS.maxLink)}`
        : bal !== null && total > bal
          ? `That's more than your balance of ${formatUsd(bal)}`
          : null;
    const ok = errors.every((e) => !e.phone && !e.amount) && !totalError && total > 0n;
    return { phones, amounts, errors, total, totalError, ok, bal };
  }, [rows, balance.data]);

  // ---------- Create: key → prepare → approve → submit → confirm ----------
  async function run(existing: Draft | null) {
    setFlowError(null);
    let d: Draft = existing ?? { linkIdHex: randomHex(16) };
    const save = (next: Draft) => {
      d = next;
      setDraft(next);
    };
    try {
      if (!d.claim) {
        setStep("key");
        const signature = await wallet.signMessage(claimMessage(d.linkIdHex));
        save({ ...d, claim: await claimKeyFromSignature(signature) });
      }
      if (!d.operation) {
        setStep("prepare");
        const body: unknown = d.body ?? {
          link_id_hex: d.linkIdHex,
          claim_pubkey: d.claim!.publicKey,
          ...(note.trim() ? { note: note.trim() } : {}),
          recipients: rows.map((r, i) => ({
            phone_e164: checked.phones[i]!,
            amount_base_units: checked.amounts[i]!,
            ...(r.label.trim() ? { label: r.label.trim() } : {}),
          })),
        };
        // Saved first: a retry must reuse the same link ID with identical input.
        save({ ...d, body });
        const res = await api<{ link: LinkDetail } & PreparedOperation>("/api/links/prepare", body);
        save({ ...d, linkId: res.link.id, operation: res });
      }
      if (!d.signed) {
        setStep("sign");
        // Re-read the operation in case the server issued a replacement transaction.
        const latest = await api<PreparedOperation & { state: string }>(
          `/api/operations/${d.operation!.operation_id}`,
        ).catch(() => d.operation!);
        if (latest.state === "finalized") return finish(d);
        const tx = await signWithWallet(latest.tx, wallet.signTransaction);
        save({ ...d, signed: { tx, key: newIdempotencyKey() } });
      }
      setStep("submit");
      await api("/api/links/submit", {
        operation_id: d.operation!.operation_id,
        tx: d.signed!.tx,
        idempotency_key: d.signed!.key,
      });
      setStep("confirm");
      // Open the share screen once the network has confirmed the payment; final settlement
      // follows a few seconds later and the share screen waits for it.
      const state = await waitForOperation(d.operation!.operation_id, undefined, 120_000, [
        "confirmed",
        "finalized",
        "failed",
      ]);
      if (state === "confirmed" || state === "finalized") return finish(d);
      if (state === "failed") {
        // Nothing moved. Start a fresh payment next time.
        setDraft(null);
        throw new FlowError("That payment didn't go through. No money left your balance.");
      }
      throw new FlowError("Still confirming. Check Activity in a minute before trying again.");
    } catch (err) {
      const text = err instanceof FlowError ? err.message : messageFor(err);
      // These mean the signed transaction can't be used again; the next try signs afresh.
      if (
        d.signed &&
        isCode(
          err,
          "transaction_message_mismatch",
          "invalid_transaction_signatures",
          "attempt_no_longer_submittable",
          "invalid_transaction",
        )
      )
        save({ ...d, signed: undefined });
      setFlowError(text);
    }
  }

  function finish(d: Draft) {
    setStep("done");
    rememberClaimSecret(d.linkId!, d.claim!.secret);
    router.push(`/send/${d.linkId}?sent=1`);
  }

  const startFlow = () => {
    setTouched(true);
    if (!checked.ok) return;
    setFlowOpen(true);
    void run(draft);
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="m-0 text-[44px] leading-[0.95] font-normal tracking-[-0.035em] md:text-[64px]">
            {batch ? "Batch payment" : "Send money"}
          </h1>
          <p className="m-0 mt-3 max-w-[52ch] text-ink/60">
            {batch
              ? "One link for the whole family. Each person verifies their own number and only sees their share."
              : "They'll get a link, verify their number, and choose naira or dollars."}
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="Send to"
          className="flex rounded-full bg-paper/70 p-1.5 shadow-[0_1px_0_white_inset] backdrop-blur"
        >
          {[
            { value: false, label: "One person", Icon: UserRound },
            { value: true, label: "Batch", Icon: Users },
          ].map(({ value, label, Icon }) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={batch === value}
              onClick={() => switchMode(value)}
              disabled={!!draft}
              className={cn(
                "relative inline-flex h-11 items-center rounded-full px-5 text-[15px] font-medium transition-colors disabled:opacity-60",
                batch !== value && "hover:bg-paper",
              )}
            >
              {batch === value && <GlassLens group="send-mode" />}
              <span className="relative inline-flex items-center gap-2">
                <Icon className="h-4 w-4" aria-hidden="true" />
                {label}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_380px]">
        <Card className="flex flex-col gap-5">
          {batch && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="text-[15px] font-medium">How many people?</span>
                <div className="flex items-center gap-1 rounded-full bg-ink/[0.05] p-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="One fewer person"
                    disabled={rows.length <= 2 || !!draft}
                    onClick={() => setCount(rows.length - 1)}
                  >
                    <Minus />
                  </Button>
                  <span className="w-8 text-center text-lg font-medium tabular-nums">
                    {rows.length}
                  </span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="One more person"
                    disabled={rows.length >= LIMITS.maxSlots || !!draft}
                    onClick={() => setCount(rows.length + 1)}
                  >
                    <Plus />
                  </Button>
                </div>
              </div>
              <Button
                variant="soft"
                size="sm"
                onClick={() => setSplitOpen(true)}
                disabled={!!draft}
              >
                <Divide aria-hidden="true" /> Split equally
              </Button>
            </div>
          )}

          <fieldset disabled={!!draft} className="contents">
            <ol className="m-0 flex list-none flex-col gap-4 p-0">
              {rows.map((row, i) => {
                const err = touched ? checked.errors[i] : null;
                const update = (patch: Partial<Row>) =>
                  setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, ...patch } : r)));
                return (
                  <li
                    key={row.id}
                    className={cn(
                      "grid grid-cols-1 gap-3 sm:grid-cols-[1.4fr_0.8fr]",
                      batch && "rounded-[22px] bg-ink/[0.03] p-4",
                    )}
                  >
                    {batch && (
                      <div className="flex items-center justify-between sm:col-span-2">
                        <span className="text-[13px] font-semibold text-ink/50">
                          Person {i + 1}
                        </span>
                        {rows.length > 2 && !draft && (
                          <button
                            type="button"
                            onClick={() => setRows((rs) => rs.filter((r) => r.id !== row.id))}
                            aria-label={`Remove person ${i + 1}`}
                            className="rounded-full p-1.5 text-ink/40 hover:bg-ink/5 hover:text-ink"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    )}
                    <Field label="Their phone number" error={err?.phone}>
                      {(id) => (
                        <PhoneInput
                          id={id}
                          value={row.phone}
                          invalid={!!err?.phone}
                          onChange={(phone) => update({ phone })}
                        />
                      )}
                    </Field>
                    <Field label="Amount" error={err?.amount}>
                      {(id) => (
                        <div className="relative">
                          <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-[16px] text-ink/50">
                            $
                          </span>
                          <input
                            id={id}
                            inputMode="decimal"
                            placeholder="0.00"
                            value={row.amount}
                            aria-invalid={!!err?.amount || undefined}
                            onChange={(e) =>
                              update({ amount: e.target.value.replace(/[^\d.]/g, "") })
                            }
                            className={cn(inputClass, "pl-8 tabular-nums")}
                          />
                        </div>
                      )}
                    </Field>
                    {batch && (
                      <Field
                        label="Private label (optional)"
                        hint="Only you see this"
                        className="sm:col-span-2"
                      >
                        {(id) => (
                          <input
                            id={id}
                            maxLength={40}
                            placeholder="e.g. Mama"
                            value={row.label}
                            onChange={(e) => update({ label: e.target.value })}
                            className={inputClass}
                          />
                        )}
                      </Field>
                    )}
                  </li>
                );
              })}
            </ol>

            <Field
              label={batch ? "Note for everyone (optional)" : "Note (optional)"}
              hint={`${note.length}/120`}
            >
              {(id) => (
                <input
                  id={id}
                  maxLength={120}
                  placeholder={batch ? "Happy Sallah from Musa" : "For school fees"}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className={inputClass}
                />
              )}
            </Field>
          </fieldset>
        </Card>

        {/* Review */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          <Card tone="ink" className="flex flex-col gap-5">
            <TintedIcon
              icon={batch ? "split" : "send"}
              tint={batch ? "rose" : "sage"}
              className="pointer-events-none absolute -top-8 -right-8 h-36 w-36 opacity-80"
            />
            <p className="relative m-0 text-[15px] text-cream/60">Total</p>
            <p className="relative m-0 -mt-3 text-[56px] leading-none font-light tracking-[-0.045em] tabular-nums">
              {formatUsd(checked.total, { cents: true })}
            </p>
            <dl className="relative m-0 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-cream/55">People</dt>
              <dd className="m-0 text-right">{rows.length}</dd>
              <dt className="text-cream/55">Balance after</dt>
              <dd className="m-0 text-right tabular-nums">
                {checked.bal === null
                  ? "—"
                  : formatUsd(checked.bal - checked.total, { cents: true })}
              </dd>
              <dt className="text-cream/55">Fees</dt>
              <dd className="m-0 text-right">Covered by Muuve</dd>
            </dl>
            <p className="relative m-0 rounded-2xl bg-cream/10 px-4 py-3 text-[13px] text-cream/75">
              Anything not claimed in 48 hours returns to you automatically. You can recall it
              sooner.
            </p>
            {touched && checked.totalError && (
              <p role="alert" className="relative m-0 text-sm text-peach-100">
                {checked.totalError}
              </p>
            )}
            <WalletGate purpose="to approve this payment">
              <Button variant="lemon" size="lg" onClick={startFlow} className="relative w-full">
                {draft ? "Continue payment" : batch ? "Create batch link" : "Create link"}
              </Button>
            </WalletGate>
            {draft && !flowOpen && (
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="relative text-sm text-cream/60 underline-offset-4 hover:text-cream hover:underline"
              >
                Discard and start over
              </button>
            )}
          </Card>
        </div>
      </div>

      <Sheet open={splitOpen} onClose={() => setSplitOpen(false)} title="Split equally">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const total = parseUsd(splitTotal);
            if (!total) return;
            const parts = splitEqually(total, rows.length);
            setRows((rs) => rs.map((r, i) => ({ ...r, amount: usdInput(parts[i]!) })));
            setSplitOpen(false);
          }}
        >
          <Field
            label="Total to share"
            hint={`Divided across ${rows.length} people. You can still edit each amount.`}
          >
            {(id) => (
              <input
                id={id}
                autoFocus
                inputMode="decimal"
                placeholder="300"
                value={splitTotal}
                onChange={(e) => setSplitTotal(e.target.value.replace(/[^\d.]/g, ""))}
                className={inputClass}
              />
            )}
          </Field>
          <Button type="submit" disabled={!parseUsd(splitTotal)}>
            Split
          </Button>
        </form>
      </Sheet>

      <Sheet
        open={flowOpen}
        onClose={() => setFlowOpen(false)}
        title="Creating your link"
        dismissible={!!flowError}
      >
        <div className="flex flex-col gap-6">
          <StepProgress steps={STEPS} current={step} failed={!!flowError} />
          {flowError && (
            <>
              <Notice tone="danger">{flowError}</Notice>
              <div className="flex gap-2">
                <Button onClick={() => void run(draft)}>Try again</Button>
                <Button variant="ghost" onClick={() => setFlowOpen(false)}>
                  Close
                </Button>
              </div>
            </>
          )}
          {!flowError && (step === "key" || step === "sign") && (
            <p className="m-0 text-sm text-ink/55">Check your wallet to approve.</p>
          )}
        </div>
      </Sheet>
    </div>
  );
}
