"use client";

import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { api, type Bank } from "@/lib/api";
import { messageFor } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { GlassLens } from "./GlassLens";

export type BankAccount = { bankCode: string; accountNumber: string; accountName: string | null };

// Shown as quick picks; every other bank is in the list below them.
const POPULAR = [/^opay/i, /^palmpay/i, /^moniepoint/i, /^kuda/i];

/** Bank picker + 10-digit account number; resolves the account name with the payout provider. */
export function BankFields({
  value,
  onChange,
  disabled,
}: {
  value: BankAccount;
  onChange(value: BankAccount): void;
  disabled?: boolean;
}) {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ banks: Bank[] }>("/api/banks")
      .then((r) => {
        setBanks(r.banks);
        const first = popularOf(r.banks)[0] ?? r.banks[0];
        if (!value.bankCode && first) onChange({ ...value, bankCode: first.code });
      })
      .catch((err) => setError(messageFor(err)));
    // Load once; onChange/value are read only to pick a default bank.
  }, []);

  useEffect(() => {
    if (!value.bankCode || !/^\d{10}$/.test(value.accountNumber)) return;
    let cancelled = false;
    setResolving(true);
    setError(null);
    api<{ account_name: string }>("/api/banks/resolve", {
      bank_code: value.bankCode,
      account_number: value.accountNumber,
    })
      .then((r) => !cancelled && onChange({ ...value, accountName: r.account_name }))
      .catch((err) => !cancelled && setError(messageFor(err)))
      .finally(() => !cancelled && setResolving(false));
    return () => {
      cancelled = true;
    };
  }, [value.bankCode, value.accountNumber]);

  const popular = popularOf(banks);
  const others = banks
    .filter((b) => !popular.includes(b))
    .sort((a, b) => a.name.localeCompare(b.name));
  const pick = (bankCode: string) => onChange({ ...value, bankCode, accountName: null });

  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Popular banks" className="grid grid-cols-2 gap-2">
        {popular.map((b) => (
          <button
            key={b.code}
            type="button"
            role="radio"
            aria-checked={value.bankCode === b.code}
            disabled={disabled}
            onClick={() => pick(b.code)}
            className={cn(
              "relative h-14 rounded-2xl text-[16px] font-medium transition-colors",
              value.bankCode !== b.code && "border border-ink/10 bg-paper/80 hover:border-ink/30",
            )}
          >
            {value.bankCode === b.code && <GlassLens group="bank" className="rounded-[19px]" />}
            <span className="relative">{b.name}</span>
          </button>
        ))}
      </div>
      {others.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="other-bank" className="text-[13px] font-medium text-ink/60">
            Another bank
          </label>
          <select
            id="other-bank"
            disabled={disabled}
            value={others.some((b) => b.code === value.bankCode) ? value.bankCode : ""}
            onChange={(e) => e.target.value && pick(e.target.value)}
            className="h-14 w-full rounded-2xl border border-ink/10 bg-paper/80 px-4 text-[16px] focus:border-ink/40 focus:bg-paper focus:outline-none"
          >
            <option value="">Choose a bank</option>
            {others.map((b) => (
              <option key={b.code} value={b.code}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="account-number" className="text-[13px] font-medium text-ink/60">
          Account number
        </label>
        <input
          id="account-number"
          inputMode="numeric"
          autoComplete="off"
          maxLength={10}
          placeholder="10 digits"
          disabled={disabled}
          value={value.accountNumber}
          onChange={(e) =>
            onChange({
              ...value,
              accountNumber: e.target.value.replace(/\D/g, "").slice(0, 10),
              accountName: null,
            })
          }
          className="h-14 w-full rounded-2xl border border-ink/10 bg-paper/80 px-4 text-[18px] tracking-[0.08em] tabular-nums focus:border-ink/40 focus:bg-paper focus:outline-none"
        />
      </div>
      <div aria-live="polite" className="min-h-6 text-[15px]">
        {resolving ? (
          <span className="text-ink/50">Checking the account…</span>
        ) : value.accountName ? (
          <span className="inline-flex items-center gap-2 font-medium text-sage-700">
            <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
            {value.accountName}
          </span>
        ) : error ? (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function popularOf(banks: Bank[]) {
  const found = POPULAR.map((re) => banks.find((b) => re.test(b.name))).filter(
    (b): b is Bank => !!b,
  );
  return found.length ? found : banks.slice(0, 4);
}
