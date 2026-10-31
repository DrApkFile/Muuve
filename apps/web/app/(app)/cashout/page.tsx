"use client";

import { useEffect, useState } from "react";
import { Banknote, Check, Lock } from "lucide-react";
import { api, newIdempotencyKey, type Payout, type PreparedOperation, type Quote } from "@/lib/api";
import { isCode, messageFor } from "@/lib/errors";
import { CLAIMS_ENABLED } from "@/lib/flags";
import { formatNgn, formatUsd, parseUsd } from "@/lib/format";
import { useBalance, useNow } from "@/lib/hooks";
import { waitForPayout } from "@/lib/payouts";
import { signWithWallet } from "@/lib/solana";
import { useWallet } from "@/lib/wallet";
import { Button } from "@/components/ui/button";
import {
  Card,
  Field,
  Notice,
  PAYOUT_META,
  Pill,
  Spinner,
  StepProgress,
  inputClass,
} from "@/components/app/kit";
import { BankFields, type BankAccount } from "@/components/app/BankFields";
import { TintedIcon } from "@/components/app/TintedIcon";
import { WalletGate } from "@/components/app/WalletGate";
import { announceBalanceChange } from "@/components/app/FundSheet";
import { cn } from "@/lib/utils";

export default function CashoutPage() {
  const balance = useBalance();
  const wallet = useWallet();
  const now = useNow(500);
  const [amountText, setAmountText] = useState("");
  const [account, setAccount] = useState<BankAccount>({
    bankCode: "",
    accountNumber: "",
    accountName: null,
  });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [phase, setPhase] = useState<"form" | "working" | "status">("form");
  const [step, setStep] = useState("prepare");
  const [payout, setPayout] = useState<Payout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<(PreparedOperation & { payout: { id: string } }) | null>(
    null,
  );

  const amount = parseUsd(amountText);
  const bal = balance.data ? BigInt(balance.data.amount_base_units) : null;
  const overBalance = !!amount && bal !== null && BigInt(amount) > bal;
  const quoteLeft = quote ? Math.max(0, new Date(quote.expires_at).getTime() - now) : 0;

  // Quotes lock for 60s. Re-quote automatically when one runs out while reviewing.
  const quoteExpired = !!quote && quoteLeft === 0;
  useEffect(() => {
    if (phase === "form" && quoteExpired && amount) void getQuote();
  }, [quoteExpired]);

  async function getQuote() {
    if (!amount) return;
    setError(null);
    try {
      setQuote(await api<Quote>("/api/payouts/quote", { amount_base_units: amount }));
    } catch (err) {
      setError(messageFor(err));
    }
  }

  async function confirm() {
    if (!quote || !account.accountName) return;
    setPhase("working");
    setError(null);
    try {
      let prep = prepared;
      if (!prep) {
        setStep("prepare");
        prep = await api<PreparedOperation & { payout: { id: string } }>("/api/payouts/prepare", {
          quote_id: quote.quote_id,
          bank_code: account.bankCode,
          account_number: account.accountNumber,
        });
        setPrepared(prep);
      }
      setStep("sign");
      const tx = await signWithWallet(prep.tx, wallet.signTransaction);
      setStep("submit");
      await api("/api/payouts/submit", {
        operation_id: prep.operation_id,
        tx,
        idempotency_key: newIdempotencyKey(),
      });
      setPhase("status");
      announceBalanceChange();
      const final = await waitForPayout(prep.payout.id, setPayout);
      if (final) announceBalanceChange();
    } catch (err) {
      if (isCode(err, "quote_expired")) {
        setPrepared(null);
        setQuote(null);
        void getQuote();
      }
      setError(messageFor(err));
      setPhase("form");
    }
  }

  if (!CLAIMS_ENABLED)
    return (
      <div className="flex flex-col gap-8">
        <h1 className="m-0 text-[44px] leading-[0.95] font-normal tracking-[-0.035em] md:text-[64px]">
          Cash out
        </h1>
        <Card tone="peach" className="flex max-w-xl flex-col gap-4">
          <TintedIcon
            icon="send"
            tint="peach"
            className="pointer-events-none absolute -top-6 -right-6 h-36 w-36"
          />
          <Pill tone="peach" className="relative self-start">
            <Lock className="h-3.5 w-3.5" aria-hidden="true" /> Opening soon
          </Pill>
          <p className="relative m-0 max-w-[38ch] text-[17px]">
            Cashing out to a Nigerian bank or OPay account opens once our payout partner checks are
            finished.
          </p>
          <p className="relative m-0 text-sm text-ink/60">
            Your dollars stay safe in your balance until then.
          </p>
        </Card>
      </div>
    );

  const meta = payout ? PAYOUT_META[payout.status] : null;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="m-0 text-[44px] leading-[0.95] font-normal tracking-[-0.035em] md:text-[64px]">
          Cash out
        </h1>
        <p className="m-0 mt-3 text-ink/60">
          Send dollars from your balance to any Nigerian bank or OPay account, in naira.
        </p>
      </div>

      {phase === "status" ? (
        <Card className="mx-auto flex w-full max-w-xl flex-col items-center gap-5 text-center">
          <span
            className={cn(
              "flex h-16 w-16 items-center justify-center rounded-full",
              payout?.status === "paid"
                ? "bg-sage-100 text-sage-700"
                : "bg-lemon-100 text-lemon-700",
            )}
          >
            {payout?.status === "paid" ? (
              <Check className="h-8 w-8" aria-hidden="true" />
            ) : (
              <Spinner className="h-7 w-7" />
            )}
          </span>
          <p className="m-0 text-[28px] font-medium tracking-[-0.02em]">
            {meta?.label ?? "Releasing your money…"}
          </p>
          {payout && (
            <>
              <p className="m-0 text-[40px] font-light tracking-[-0.04em] tabular-nums">
                {formatNgn(payout.amount_ngn_kobo)}
              </p>
              <p className="m-0 text-sm text-ink/55">
                To {payout.account_name} · ••••{payout.account_last4}
                {payout.provider_ref ? ` · ref ${payout.provider_ref}` : ""}
              </p>
            </>
          )}
          <Notice className="w-full text-left">
            Demo payout: no real naira moves. A real payout partner replaces this step in
            production.
          </Notice>
          {payout?.status === "failed" && (
            <Notice tone="danger" className="w-full text-left">
              We couldn&apos;t send to that account. Your dollars are returned to your balance.
            </Notice>
          )}
          {meta?.done && (
            <Button
              onClick={() => {
                setPhase("form");
                setPayout(null);
                setPrepared(null);
                setQuote(null);
                setAmountText("");
              }}
            >
              Done
            </Button>
          )}
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_400px]">
          <Card className="flex flex-col gap-6">
            <Field
              label="Amount in dollars"
              error={overBalance ? "That's more than your balance" : null}
              hint={bal !== null ? `Balance ${formatUsd(bal, { cents: true })}` : undefined}
            >
              {(id) => (
                <div className="relative">
                  <span className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-[22px] text-ink/45">
                    $
                  </span>
                  <input
                    id={id}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={amountText}
                    disabled={phase === "working"}
                    onChange={(e) => {
                      setAmountText(e.target.value.replace(/[^\d.]/g, ""));
                      setQuote(null);
                      setPrepared(null);
                    }}
                    className={cn(inputClass, "h-16 pl-9 text-[28px] font-light tabular-nums")}
                  />
                </div>
              )}
            </Field>
            <BankFields
              value={account}
              disabled={phase === "working"}
              onChange={(next) => {
                setAccount(next);
                setPrepared(null);
              }}
            />
          </Card>

          <Card tone="ink" className="flex flex-col gap-5 lg:sticky lg:top-6 lg:self-start">
            <p className="m-0 text-[15px] text-cream/60">They&apos;ll receive</p>
            <p className="m-0 -mt-3 text-[44px] leading-none font-light tracking-[-0.04em] tabular-nums">
              {quote ? formatNgn(quote.amount_ngn_kobo) : "₦—"}
            </p>
            {quote && (
              <p className="m-0 -mt-2 text-sm text-cream/60">
                at ₦{quote.rate_ngn_per_usd.replace(/\.?0+$/, "")} per $1 (mock rate) · locked for{" "}
                <span className="tabular-nums">
                  0:{String(Math.ceil(quoteLeft / 1000)).padStart(2, "0")}
                </span>
              </p>
            )}
            {phase === "working" ? (
              <StepProgress
                steps={[
                  { key: "prepare", label: "Lock the rate and account" },
                  { key: "sign", label: "Approve in your wallet" },
                  { key: "submit", label: "Send for payout" },
                ]}
                current={step}
              />
            ) : (
              <WalletGate purpose="to cash out">
                {!quote ? (
                  <Button
                    variant="lemon"
                    size="lg"
                    onClick={getQuote}
                    disabled={!amount || overBalance}
                  >
                    <Banknote aria-hidden="true" /> Get rate
                  </Button>
                ) : (
                  <Button
                    variant="lemon"
                    size="lg"
                    onClick={confirm}
                    disabled={!account.accountName || quoteLeft === 0}
                  >
                    Confirm cash-out
                  </Button>
                )}
              </WalletGate>
            )}
            {!account.accountName && quote && (
              <p className="m-0 text-[13px] text-cream/55">
                Enter the account so we can show the account name before you confirm.
              </p>
            )}
            {error && (
              <p role="alert" className="m-0 text-sm text-peach-100">
                {error}
              </p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
