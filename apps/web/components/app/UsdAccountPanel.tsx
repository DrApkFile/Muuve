"use client";

import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { api, type UsdAccount } from "@/lib/api";
import { messageFor } from "@/lib/errors";
import { formatUsd } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Field, Notice, Spinner, inputClass } from "./kit";

/**
 * Add money from a US bank: Bridge's identity check, then US account details. Deposits are
 * credited to the balance once each; in the test setup a deposit can be simulated.
 */
export function UsdAccountPanel({ onCredited }: { onCredited(): void }) {
  const [account, setAccount] = useState<UsdAccount | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [amount, setAmount] = useState("100");

  async function run(label: string, call: () => Promise<UsdAccount>) {
    setBusy(label);
    setError(null);
    try {
      setAccount(await call());
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(null);
    }
  }
  const refresh = () => run("refresh", () => api<UsdAccount>("/api/usd-account"));

  useEffect(() => void refresh(), []);

  // Poll while a deposit is still being credited.
  const pending = account?.deposits?.some((d) => !d.credited) ?? false;
  const credited = account?.deposits?.filter((d) => d.credited).length ?? 0;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void api<UsdAccount>("/api/usd-account").then(setAccount), 3000);
    return () => clearInterval(t);
  }, [pending]);
  useEffect(() => {
    if (credited) onCredited();
  }, [credited]);

  if (!account)
    return (
      <div className="flex justify-center py-8 text-ink/50">
        {error ? <Notice tone="danger">{error}</Notice> : <Spinner className="h-6 w-6" />}
      </div>
    );

  return (
    <div className="flex flex-col gap-5">
      {account.sandbox && (
        <p className="m-0 text-sm text-ink/60">
          Test setup: identity checks and deposits are simulated. No real dollars move.
        </p>
      )}

      {account.status === "none" && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run("start", () =>
              api<UsdAccount>("/api/usd-account", { full_name: name.trim(), email: email.trim() }),
            );
          }}
        >
          <p className="m-0 text-[15px] text-ink/70">
            Get your own US account details and pay in from any US bank by ACH or wire. Our partner
            Bridge runs a one-time identity check; Muuve never sees your documents.
          </p>
          <Field label="Full legal name">
            {(id) => (
              <input
                id={id}
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputClass}
              />
            )}
          </Field>
          <Field label="Email" hint="Bridge sends updates about your check here">
            {(id) => (
              <input
                id={id}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
              />
            )}
          </Field>
          <Button type="submit" size="lg" disabled={!!busy || name.trim().length < 2 || !email}>
            {busy === "start" && <Spinner />} Start identity check
          </Button>
        </form>
      )}

      {account.status === "pending" && (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-[15px] text-ink/70">
            Finish two quick steps with Bridge, then come back and refresh.
          </p>
          {account.tos_url && (
            <Button asChild variant="soft">
              <a href={account.tos_url} target="_blank" rel="noreferrer">
                1. Accept the terms <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          )}
          {account.kyc_url && (
            <Button asChild variant="soft">
              <a href={account.kyc_url} target="_blank" rel="noreferrer">
                2. Verify your identity <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          )}
          <p className="m-0 text-[13px] text-ink/50">
            Identity check: {account.kyc_status?.replace(/_/g, " ")} · Terms: {account.tos_status}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void refresh()} disabled={!!busy}>
              {busy === "refresh" ? <Spinner /> : <RefreshCw aria-hidden="true" />} I&apos;ve
              finished, refresh
            </Button>
            {account.sandbox && (
              <Button
                variant="ghost"
                disabled={!!busy}
                onClick={() =>
                  void run("approve", () => api<UsdAccount>("/api/usd-account/sandbox/approve", {}))
                }
              >
                {busy === "approve" && <Spinner />} Approve instantly (test)
              </Button>
            )}
          </div>
        </div>
      )}

      {account.status === "rejected" && (
        <Notice tone="danger">
          Bridge couldn&apos;t verify your identity, so a US account can&apos;t be opened. You can
          still add money from a wallet.
        </Notice>
      )}

      {account.status === "active" && account.account && (
        <div className="flex flex-col gap-4">
          <dl className="m-0 grid grid-cols-1 gap-2 rounded-[22px] bg-ink/[0.04] p-4">
            <Detail label="Bank" value={account.account.bank_name} />
            <Detail label="Account holder" value={account.account.beneficiary_name} />
            <Detail label="Routing number" value={account.account.routing_number} copy />
            <Detail label="Account number" value={account.account.account_number} copy />
            <Detail label="Bank address" value={account.account.bank_address} />
          </dl>
          <p className="m-0 text-[13px] text-ink/55">
            Send by ACH or wire from any US bank. Deposits land in your Muuve balance as dollars.
          </p>
          {account.sandbox && (
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run("deposit", () =>
                  api<UsdAccount>("/api/usd-account/sandbox/deposit", { amount_usd: amount }),
                );
              }}
            >
              <Field label="Simulate a deposit ($)" className="flex-1">
                {(id) => (
                  <input
                    id={id}
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                    className={inputClass}
                  />
                )}
              </Field>
              <Button type="submit" size="lg" disabled={!!busy || !amount}>
                {busy === "deposit" && <Spinner />} Simulate
              </Button>
            </form>
          )}
          {!!account.deposits?.length && (
            <ul className="m-0 flex list-none flex-col divide-y divide-dashed divide-ink/15 p-0">
              {account.deposits.map((d) => (
                <li key={d.id} className="flex items-center justify-between py-2.5 text-[15px]">
                  <span className="tabular-nums">{formatUsd(d.amount_base_units)}</span>
                  <span className="inline-flex items-center gap-1.5 text-ink/60">
                    {d.credited ? (
                      <>
                        <Check className="h-4 w-4 text-sage-700" aria-hidden="true" /> In your
                        balance
                      </>
                    ) : (
                      <>
                        <Spinner /> Arriving
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {account.sync_error && (
        <p className="m-0 text-[13px] text-ink/50">
          Couldn&apos;t reach Bridge just now; showing the last known status.
        </p>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

function Detail({ label, value, copy }: { label: string; value: string | null; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[13px] text-ink/55">{label}</dt>
      <dd className="m-0 flex items-center gap-2 text-right font-medium tabular-nums">
        {value}
        {copy && (
          <button
            type="button"
            aria-label={`Copy ${label.toLowerCase()}`}
            onClick={async () => {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="rounded-full p-1 text-ink/50 hover:bg-ink/5 hover:text-ink"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </button>
        )}
      </dd>
    </div>
  );
}
