"use client";

import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { api, type Bank } from "@/lib/api";
import { messageFor } from "@/lib/errors";
import { cn } from "@/lib/utils";

export type BankAccount = { bankCode: string; accountNumber: string; accountName: string | null };

/** Bank picker + 10-digit account number; resolves the account name (mock data on devnet). */
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
        if (!value.bankCode && r.banks[0]) onChange({ ...value, bankCode: r.banks[0].code });
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

  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Bank" className="grid grid-cols-2 gap-2">
        {banks.map((b) => (
          <button
            key={b.code}
            type="button"
            role="radio"
            aria-checked={value.bankCode === b.code}
            disabled={disabled}
            onClick={() => onChange({ ...value, bankCode: b.code, accountName: null })}
            className={cn(
              "h-14 rounded-2xl text-[16px] font-medium transition-colors",
              value.bankCode === b.code
                ? "bg-ink text-cream"
                : "border border-ink/10 bg-paper/80 hover:border-ink/30",
            )}
          >
            {b.name}
          </button>
        ))}
      </div>
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
