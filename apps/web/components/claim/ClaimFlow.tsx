"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, Clock3, Lock, MessageSquareText, PiggyBank, Wallet } from "lucide-react";
import {
  api,
  ApiError,
  newIdempotencyKey,
  type Payout,
  type PreparedOperation,
  type PublicPreview,
  type Quote,
  type Share,
} from "@/lib/api";
import { isCode, messageFor } from "@/lib/errors";
import { CLAIMS_ENABLED, KEEP_ENABLED } from "@/lib/flags";
import { formatNgn, formatUsd, timeLeft } from "@/lib/format";
import { waitForPayout } from "@/lib/payouts";
import { decodeClaimSecret, signWithClaimKey, waitForOperation } from "@/lib/solana";
import { Button } from "@/components/ui/button";
import { PhoneInput, toE164, type PhoneValue } from "@/components/app/PhoneInput";
import { BankFields, type BankAccount } from "@/components/app/BankFields";

// Recipient screen. Rules (frontend guide §4.1): light first load, one action per screen,
// no crypto words, the #k= secret stays in memory only, never show other recipients.

type Step =
  | "loading"
  | "missing"
  | "preview"
  | "phone"
  | "code"
  | "share"
  | "preparing"
  | "bank"
  | "sending"
  | "status"
  | "account"
  | "keeping"
  | "kept";

const RESEND_AFTER_MS = 60_000;

function Screen({
  children,
  tone = "lemon",
}: {
  children: ReactNode;
  tone?: "lemon" | "sage" | "peach";
}) {
  const bg = {
    lemon: "linear-gradient(180deg,#F2ECDF 0%,#F4EBC6 100%)",
    sage: "linear-gradient(180deg,#E9EBE0 0%,#DFE9D4 100%)",
    peach: "linear-gradient(180deg,#F8DCC7 0%,#F9CBA9 100%)",
  }[tone];
  return (
    <div className="relative flex min-h-svh flex-col text-ink" style={{ background: bg }}>
      <div className="grain pointer-events-none absolute inset-0" aria-hidden="true" />
      <header className="relative flex h-16 items-center px-5">
        <span className="inline-flex items-center gap-2 text-[22px] font-semibold tracking-tight">
          <span className="h-3 w-3 rounded-full bg-ink" aria-hidden="true" />
          muuve
        </span>
      </header>
      <main className="relative mx-auto flex w-full max-w-[460px] flex-1 flex-col px-5 pt-6 pb-10 text-[18px]">
        {children}
      </main>
    </div>
  );
}

function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-8">
      <h1 className="m-0 text-[38px] leading-[1] font-medium tracking-[-0.035em] text-balance">
        {children}
      </h1>
      {sub && <p className="m-0 mt-3 text-[18px] text-ink/65">{sub}</p>}
    </div>
  );
}

function Terminal({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <Title sub={body}>{title}</Title>
      {action && <div className="mt-auto">{action}</div>}
    </div>
  );
}

function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="m-0 mt-3 text-[16px] font-medium text-destructive">
      {children}
    </p>
  );
}

export function ClaimFlow({ linkId }: { linkId: string }) {
  const secret = useRef<Uint8Array | null>(null);
  const [step, setStep] = useState<Step>("loading");
  const [preview, setPreview] = useState<PublicPreview | null>(null);
  const [previewError, setPreviewError] = useState<"not_found" | "other" | null>(null);
  const [phone, setPhone] = useState<PhoneValue>({ country: "NG", number: "" });
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [resendAt, setResendAt] = useState(0);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [share, setShare] = useState<Share | null>(null);
  const [notOnPayment, setNotOnPayment] = useState(false);
  const [account, setAccount] = useState<BankAccount>({
    bankCode: "",
    accountNumber: "",
    accountName: null,
  });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [payout, setPayout] = useState<Payout | null>(null);
  const [retryOf, setRetryOf] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");

  // 1. Take the key from the fragment into memory, then wipe it from the address bar.
  useEffect(() => {
    const match = window.location.hash.match(/k=([1-9A-HJ-NP-Za-km-z]+)/);
    secret.current = match ? decodeClaimSecret(match[1]!) : null;
    if (window.location.hash)
      history.replaceState(null, "", window.location.pathname + window.location.search);

    // A link shared the moment it was sent can take a few seconds to open; retry a
    // not-found briefly before saying so.
    let cancelled = false;
    async function load(tries: number): Promise<void> {
      try {
        const p = await api<PublicPreview>(`/api/public/links/${linkId}`);
        if (cancelled) return;
        setPreview(p);
        setStep(secret.current ? "preview" : "missing");
      } catch (err) {
        if (cancelled) return;
        const notFound = err instanceof ApiError && err.status === 404;
        if (notFound && tries > 0) {
          await new Promise((r) => setTimeout(r, 3000));
          return load(tries - 1);
        }
        setPreviewError(notFound ? "not_found" : "other");
        setStep("preview");
      }
    }
    void load(5);
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const go = (next: Step) => {
    setError(null);
    setStep(next);
  };
  const sender = preview?.sender_first_name || "Someone";
  const e164 = toE164(phone);
  const left = timeLeft(preview?.expires_at ?? null, now);

  // Claim sessions last 20 minutes. If one lapses, go back and verify again.
  function handle(err: unknown) {
    if (err instanceof ApiError && err.status === 401 && step !== "code") {
      setError("For your safety, please verify your number again.");
      setStep("phone");
      return;
    }
    setError(messageFor(err));
  }

  async function sendCode() {
    if (!e164 || busy) return;
    // Back-then-send within the cooldown reuses the code already on its way: each send
    // counts toward 3 per 10 minutes, and SMS can take a minute to arrive.
    if (challengeId && sentTo === e164 && Date.now() < resendAt) {
      go("code");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ challenge_id: string }>("/api/auth/otp/send", {
        phone_e164: e164,
        channel: "sms",
        purpose: "claim",
        link_id: linkId,
      });
      setChallengeId(res.challenge_id);
      setSentTo(e164);
      setCode("");
      setResendAt(Date.now() + RESEND_AFTER_MS);
      go("code");
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadShare() {
    try {
      const s = await api<Share>(`/api/claims/${linkId}/share`);
      setShare(s);
      setNotOnPayment(false);
      go("share");
      if (s.status === "cashing_out" && s.payout) void followPayout(s.payout.id);
    } catch (err) {
      if (isCode(err, "not_on_payment")) {
        setNotOnPayment(true);
        go("share");
      } else handle(err);
    }
  }

  async function verify(value: string) {
    if (!challengeId || busy || !/^\d{6}$/.test(value)) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/otp/verify", { challenge_id: challengeId, code: value });
      await loadShare();
    } catch (err) {
      setCode("");
      if (isCode(err, "not_on_payment")) {
        setNotOnPayment(true);
        go("share");
      } else setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  /** Claim-key signs the exact server transaction; submit; wait for the network. */
  async function signAndSubmit(path: string, prepared: PreparedOperation) {
    if (!secret.current) throw new Error("missing_key");
    const tx = await signWithClaimKey(prepared.tx, secret.current);
    await api(path, {
      operation_id: prepared.operation_id,
      tx,
      idempotency_key: newIdempotencyKey(),
    });
  }

  // 2. Cash out: reserve the share (intent), then bank → rate → confirm.
  async function startCashout() {
    go("preparing");
    try {
      const prepared = await api<PreparedOperation>(`/api/claims/${linkId}/intent/prepare`, {
        path: "cashout",
      });
      if (prepared.state !== "finalized") {
        await signAndSubmit(`/api/claims/${linkId}/intent/submit`, prepared);
        const state = await waitForOperation(prepared.operation_id);
        if (state !== "finalized") throw new Error(state === "failed" ? "intent_failed" : "slow");
      }
      go("bank");
    } catch (err) {
      setStep("share");
      setError(
        err instanceof Error && err.message === "slow"
          ? "This is taking longer than usual. Try again in a minute."
          : err instanceof Error && err.message === "intent_failed"
            ? "That didn't go through. Your money is safe. Try again."
            : messageFor(err),
      );
    }
  }

  async function getQuote() {
    setError(null);
    try {
      setQuote(
        await api<Quote>(
          `/api/claims/${linkId}/cashout/quote`,
          retryOf ? { retry_of: retryOf } : {},
        ),
      );
    } catch (err) {
      handle(err);
    }
  }

  // Fetch a rate as soon as the account name is confirmed; refresh when it runs out.
  const quoteLeft = quote ? Math.max(0, new Date(quote.expires_at).getTime() - now) : 0;
  const quoteExpired = !!quote && quoteLeft === 0;
  useEffect(() => {
    if (step === "bank" && account.accountName && (!quote || quoteExpired)) void getQuote();
  }, [step, account.accountName, quoteExpired]);

  async function confirmCashout() {
    if (!quote || !account.accountName || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (retryOf) {
        const res = await api<{ payout: { id: string } }>(`/api/claims/${linkId}/cashout/retry`, {
          quote_id: quote.quote_id,
          bank_code: account.bankCode,
          account_number: account.accountNumber,
          idempotency_key: newIdempotencyKey(),
        });
        go("status");
        void followPayout(res.payout.id);
        return;
      }
      go("sending");
      const prepared = await api<PreparedOperation & { payout: { id: string } }>(
        `/api/claims/${linkId}/cashout/prepare`,
        {
          quote_id: quote.quote_id,
          bank_code: account.bankCode,
          account_number: account.accountNumber,
        },
      );
      await signAndSubmit(`/api/claims/${linkId}/cashout/submit`, prepared);
      go("status");
      void followPayout(prepared.payout.id);
    } catch (err) {
      if (isCode(err, "quote_expired")) setQuote(null);
      setStep("bank");
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  // 3. Keep in dollars: needs a Muuve account for this number, which gets a dollar
  // balance created for it on the server. Then reserve the share for keeping and release it.
  async function startKeep() {
    go("keeping");
    try {
      const signedIn = await api("/api/me")
        .then(() => true)
        .catch((err) => {
          if (err instanceof ApiError && err.status === 401) return false;
          throw err;
        });
      if (!signedIn) {
        setStep("account");
        return;
      }
      await finishKeep();
    } catch (err) {
      keepFailed(err);
    }
  }

  async function createAccount() {
    const displayName = name.trim();
    if (!displayName || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/signup", { display_name: displayName, origin: "muuve" });
      go("keeping");
      await finishKeep();
    } catch (err) {
      if (step === "account") setError(messageFor(err));
      else keepFailed(err);
    } finally {
      setBusy(false);
    }
  }

  async function finishKeep() {
    await api("/api/auth/wallet/embedded", {});
    // A failed bank payout already moved the share out of escrow; keep resolves it directly.
    if (share?.status !== "cashing_out") {
      const intent = await api<PreparedOperation>(`/api/claims/${linkId}/intent/prepare`, {
        path: "keep",
      });
      if (intent.state !== "finalized") {
        await signAndSubmit(`/api/claims/${linkId}/intent/submit`, intent);
        const state = await waitForOperation(intent.operation_id);
        if (state !== "finalized") throw new Error(state === "failed" ? "intent_failed" : "slow");
      }
    }
    const res = await api<Partial<PreparedOperation> & { done?: boolean }>(
      `/api/claims/${linkId}/keep/prepare`,
      {},
    );
    if (!res.done && res.operation_id) {
      if (res.tx)
        await signAndSubmit(`/api/claims/${linkId}/keep/submit`, res as PreparedOperation);
      const state = await waitForOperation(res.operation_id);
      if (state !== "finalized") throw new Error(state === "failed" ? "intent_failed" : "slow");
    }
    go("kept");
  }

  function keepFailed(err: unknown) {
    setStep(share?.status === "cashing_out" ? "status" : "share");
    setError(
      err instanceof Error && err.message === "slow"
        ? "This is taking longer than usual. Try again in a minute."
        : err instanceof Error && err.message === "intent_failed"
          ? "That didn't go through. Your money is safe. Try again."
          : messageFor(err),
    );
  }

  async function followPayout(id: string) {
    setStep("status");
    const final = await waitForPayout(id, setPayout);
    if (final?.status === "failed") setRetryOf(final.id);
  }

  const amount = share?.amount_base_units ?? preview?.amount_base_units;

  // ---------- Screens ----------

  if (step === "loading")
    return (
      <Screen>
        <div className="flex flex-1 items-center justify-center text-ink/50">Opening…</div>
      </Screen>
    );

  if (previewError === "not_found")
    return (
      <Screen>
        <Terminal
          title="We couldn't find this payment"
          body="The link may be incomplete, or the payment was cancelled. Check with the person who sent it."
        />
      </Screen>
    );
  if (previewError)
    return (
      <Screen>
        <Terminal
          title="Something went wrong"
          body="We couldn't open this payment. Check your connection and try again."
          action={
            <Button size="lg" className="w-full" onClick={() => window.location.reload()}>
              Try again
            </Button>
          }
        />
      </Screen>
    );

  if (step === "missing")
    return (
      <Screen>
        <Terminal
          title="This link is incomplete"
          body={`Part of the link is missing, so the money can't be opened. Ask ${sender} to share it with you again, and open it straight from WhatsApp.`}
        />
      </Screen>
    );

  if (step === "preview") {
    const expired = !left || left.ms === 0;
    if (preview?.status === "settled" || expired)
      return (
        <Screen>
          <Terminal
            title={expired ? "This money went back" : "This payment is finished"}
            body={
              expired
                ? `It wasn't claimed in time, so it returned to ${sender}. Ask them to send it again.`
                : `If ${sender} sent you money here, verify your number to see what happened to your share.`
            }
            action={
              !expired ? (
                <Button size="lg" className="w-full" onClick={() => go("phone")}>
                  Check my share
                </Button>
              ) : undefined
            }
          />
        </Screen>
      );
    return (
      <Screen>
        <div className="flex flex-1 flex-col">
          <p className="m-0 text-[16px] text-ink/60">You&apos;ve got money</p>
          <h1 className="m-0 mt-2 text-[44px] leading-[0.98] font-medium tracking-[-0.04em] text-balance">
            {preview?.kind === "single" && preview.amount_base_units
              ? `${sender} sent you ${formatUsd(preview.amount_base_units)}`
              : `${sender} sent you money`}
          </h1>
          {preview?.note && (
            <p className="m-0 mt-5 rounded-3xl bg-paper/70 px-5 py-4 text-[18px]">
              “{preview.note}”
            </p>
          )}
          <p className="m-0 mt-5 inline-flex items-center gap-2 text-[16px] text-ink/60">
            <Clock3 className="h-4 w-4" aria-hidden="true" />
            Available for {left!.label} more
          </p>
          <div className="mt-auto pt-10">
            <Button size="lg" className="h-16 w-full text-[18px]" onClick={() => go("phone")}>
              Continue
            </Button>
            <p className="m-0 mt-4 text-center text-[14px] text-ink/50">
              No app to install. You&apos;ll verify your number with a code.
            </p>
          </div>
        </div>
      </Screen>
    );
  }

  if (step === "phone")
    return (
      <Screen>
        <form
          className="flex flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void sendCode();
          }}
        >
          <button
            type="button"
            onClick={() => go("preview")}
            className="mb-6 inline-flex items-center gap-2 self-start text-[16px] text-ink/60"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back
          </button>
          <Title sub="We'll text you a 6-digit code.">Enter the number {sender} sent this to</Title>
          <PhoneInput size="lg" value={phone} onChange={setPhone} autoFocus />
          {error && <ErrorText>{error}</ErrorText>}
          <div className="mt-auto pt-10">
            <Button
              type="submit"
              size="lg"
              className="h-16 w-full text-[18px]"
              disabled={!e164 || busy}
            >
              <MessageSquareText aria-hidden="true" />
              {busy ? "Sending…" : "Text me a code"}
            </Button>
          </div>
        </form>
      </Screen>
    );

  if (step === "code") {
    const wait = Math.max(0, Math.ceil((resendAt - now) / 1000));
    return (
      <Screen tone="sage">
        <form
          className="flex flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void verify(code);
          }}
        >
          <Title
            sub={`Sent to the number ending ${e164?.slice(-4) ?? ""}. Texts can take a minute to arrive.`}
          >
            Enter the code
          </Title>
          <label htmlFor="otp" className="sr-only">
            6-digit code
          </label>
          <input
            id="otp"
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="••••••"
            value={code}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
              setCode(digits);
              if (digits.length === 6) void verify(digits);
            }}
            className="h-20 w-full rounded-3xl border border-ink/10 bg-paper/80 text-center text-[34px] font-medium tracking-[0.45em] tabular-nums focus:border-ink/40 focus:outline-none"
          />
          {error && <ErrorText>{error}</ErrorText>}
          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[16px]">
            <button
              type="button"
              disabled={wait > 0 || busy}
              onClick={() => void sendCode()}
              className="font-semibold underline-offset-4 hover:underline disabled:font-normal disabled:text-ink/45 disabled:no-underline"
            >
              {wait > 0 ? `Resend in ${wait}s` : "Resend code"}
            </button>
            <button type="button" onClick={() => go("phone")} className="text-ink/60">
              Use a different number
            </button>
          </div>
          <div className="mt-auto pt-10">
            <Button
              type="submit"
              size="lg"
              className="h-16 w-full text-[18px]"
              disabled={code.length !== 6 || busy}
            >
              {busy ? "Checking…" : "Verify"}
            </Button>
          </div>
        </form>
      </Screen>
    );
  }

  if (step === "share") {
    if (notOnPayment)
      return (
        <Screen>
          <Terminal
            title="This number isn't on this payment"
            body={`Check with ${sender} which number they used.`}
            action={
              <Button size="lg" className="w-full" onClick={() => go("phone")}>
                Try another number
              </Button>
            }
          />
        </Screen>
      );
    const s = share!;
    if (s.status === "recalled")
      return (
        <Screen>
          <Terminal
            title="The sender cancelled this payment"
            body={`Ask ${sender} if they meant to.`}
          />
        </Screen>
      );
    if (s.status === "returned")
      return (
        <Screen>
          <Terminal
            title="This money went back to the sender"
            body={`Ask ${sender} to send it again.`}
          />
        </Screen>
      );
    if (s.status === "kept")
      return (
        <Screen tone="sage">
          <Terminal
            title="This is in your Muuve balance"
            body={`${formatUsd(s.amount_base_units, { cents: true })} is already yours in dollars.`}
          />
        </Screen>
      );
    if (s.status === "cashed_out")
      return (
        <Screen tone="sage">
          <Terminal
            title="You already cashed this out"
            body={
              s.payout?.amount_ngn_kobo
                ? `${formatNgn(s.payout.amount_ngn_kobo)} was sent to your account.`
                : "It was sent to your bank account."
            }
          />
        </Screen>
      );
    return (
      <Screen>
        <div className="flex flex-1 flex-col">
          <p className="m-0 text-[16px] text-ink/60">Your share</p>
          <p className="m-0 mt-1 text-[64px] leading-none font-light tracking-[-0.05em] tabular-nums">
            {formatUsd(s.amount_base_units, { cents: true })}
          </p>
          <p className="m-0 mt-3 text-[16px] text-ink/60">from {sender}</p>
          <div className="mt-8 flex flex-col gap-3">
            <button
              type="button"
              disabled={!CLAIMS_ENABLED}
              onClick={() => void startCashout()}
              className="flex w-full items-start gap-4 rounded-3xl bg-ink p-5 text-left text-cream transition-transform enabled:hover:scale-[1.01] disabled:opacity-60 motion-reduce:hover:scale-100"
            >
              <Wallet className="mt-1 h-6 w-6 shrink-0" aria-hidden="true" />
              <span>
                <span className="block text-[20px] font-medium">Cash out to bank or OPay</span>
                <span className="block text-[15px] text-cream/65">
                  {CLAIMS_ENABLED
                    ? "Naira in your account. No account needed with us."
                    : "Opening soon"}
                </span>
              </span>
            </button>
            <button
              type="button"
              disabled={!KEEP_ENABLED}
              onClick={() => void startKeep()}
              className="flex w-full items-start gap-4 rounded-3xl border border-ink/10 bg-paper/70 p-5 text-left transition-transform enabled:hover:scale-[1.01] disabled:opacity-60 motion-reduce:hover:scale-100"
            >
              <PiggyBank className="mt-1 h-6 w-6 shrink-0" aria-hidden="true" />
              <span>
                <span className="block text-[20px] font-medium">Keep in dollars</span>
                <span className="block text-[15px] text-ink/60">
                  {KEEP_ENABLED
                    ? "Hold it in a Muuve account and cash out whenever you like."
                    : "Opening soon"}
                </span>
              </span>
            </button>
          </div>
          {!CLAIMS_ENABLED && (
            <p className="m-0 mt-5 inline-flex items-start gap-2 text-[15px] text-ink/60">
              <Lock className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
              Your money is held safely for you. Come back to this link before it expires.
            </p>
          )}
          {error && <ErrorText>{error}</ErrorText>}
        </div>
      </Screen>
    );
  }

  if (step === "account")
    return (
      <Screen tone="sage">
        <form
          className="flex flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void createAccount();
          }}
        >
          <Title sub="Your dollars stay in your Muuve account, under this phone number. Cash out to your bank whenever you like.">
            Create your Muuve account
          </Title>
          <label htmlFor="name" className="mb-2 text-[16px] font-medium text-ink/70">
            Your name
          </label>
          <input
            id="name"
            autoFocus
            autoComplete="name"
            maxLength={60}
            placeholder="e.g. Ada Okafor"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-14 w-full rounded-2xl border border-ink/10 bg-paper/80 px-4 text-[18px] placeholder:text-ink/35 focus:border-ink/40 focus:outline-none"
          />
          {error && <ErrorText>{error}</ErrorText>}
          <div className="mt-auto flex flex-col gap-3 pt-10">
            <Button
              type="submit"
              size="lg"
              className="h-16 w-full text-[18px]"
              disabled={!name.trim() || busy}
            >
              {busy ? "Creating…" : "Create account and keep"}
            </Button>
            <button
              type="button"
              onClick={() => go(share?.status === "cashing_out" ? "status" : "share")}
              className="text-[16px] text-ink/60"
            >
              Back
            </button>
          </div>
        </form>
      </Screen>
    );

  if (step === "keeping")
    return (
      <Screen tone="sage">
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <span className="h-12 w-12 animate-spin rounded-full border-4 border-ink/15 border-t-ink" />
          <p className="m-0 text-[20px] font-medium">Moving your dollars to your account…</p>
          <p className="m-0 text-[16px] text-ink/55">This usually takes a few seconds.</p>
        </div>
      </Screen>
    );

  if (step === "kept")
    return (
      <Screen tone="sage">
        <div className="flex flex-1 flex-col">
          <span className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-sage-500 text-ink">
            <Check className="h-8 w-8" aria-hidden="true" />
          </span>
          <Title sub="They're in your Muuve account. Cash out to your bank or send them on whenever you like.">
            {amount ? formatUsd(amount, { cents: true }) : "Your dollars"} kept
          </Title>
          <div className="mt-auto">
            <Button asChild size="lg" className="h-16 w-full text-[18px]">
              <a href="/home">Open my account</a>
            </Button>
          </div>
        </div>
      </Screen>
    );

  if (step === "preparing" || step === "sending")
    return (
      <Screen>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <span className="h-12 w-12 animate-spin rounded-full border-4 border-ink/15 border-t-ink" />
          <p className="m-0 text-[20px] font-medium">
            {step === "preparing" ? "Getting your money ready…" : "Releasing your money…"}
          </p>
          <p className="m-0 text-[16px] text-ink/55">This usually takes a few seconds.</p>
        </div>
      </Screen>
    );

  if (step === "bank")
    return (
      <Screen tone="peach">
        <div className="flex flex-1 flex-col">
          <Title sub={retryOf ? "Choose another account. Your money is safe." : undefined}>
            Where should we send it?
          </Title>
          <BankFields value={account} onChange={setAccount} disabled={busy} />
          {quote && account.accountName && (
            <div className="mt-6 rounded-3xl bg-paper/80 p-5">
              <p className="m-0 text-[15px] text-ink/60">You&apos;ll receive</p>
              <p className="m-0 mt-1 text-[36px] leading-none font-medium tracking-[-0.03em] tabular-nums">
                {formatNgn(quote.amount_ngn_kobo)}
              </p>
              <p className="m-0 mt-2 text-[15px] text-ink/60">
                ₦{quote.rate_ngn_per_usd.replace(/\.?0+$/, "")} per $1 · locked for{" "}
                <span className="tabular-nums">
                  0:{String(Math.ceil(quoteLeft / 1000)).padStart(2, "0")}
                </span>
              </p>
            </div>
          )}
          {error && <ErrorText>{error}</ErrorText>}
          <div className="mt-auto pt-8">
            <Button
              size="lg"
              className="h-16 w-full text-[18px]"
              disabled={!quote || !account.accountName || quoteLeft === 0 || busy}
              onClick={() => void confirmCashout()}
            >
              Confirm
            </Button>
            <p className="m-0 mt-3 text-center text-[13px] text-ink/50">
              Demo: payouts and rates are simulated. No real naira moves yet.
            </p>
          </div>
        </div>
      </Screen>
    );

  // status
  const paid = payout?.status === "paid";
  const failed = payout?.status === "failed";
  return (
    <Screen tone={paid ? "sage" : failed ? "peach" : "lemon"}>
      <div className="flex flex-1 flex-col">
        {paid ? (
          <>
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-sage-500 text-ink">
              <Check className="h-8 w-8" aria-hidden="true" />
            </span>
            <Title sub={`Sent to ${payout!.account_name} · ••••${payout!.account_last4}`}>
              {formatNgn(payout!.amount_ngn_kobo)} is on its way
            </Title>
            {payout!.provider_ref && (
              <p className="m-0 -mt-4 text-[15px] text-ink/55">Reference {payout!.provider_ref}</p>
            )}
            <p className="m-0 mt-6 rounded-3xl bg-paper/70 px-5 py-4 text-[15px] text-ink/60">
              Demo payout: simulated, no real naira moved.
            </p>
          </>
        ) : failed ? (
          <>
            <Title sub={`Your ${amount ? formatUsd(amount) : "money"} is safe.`}>
              We couldn&apos;t send to that account
            </Title>
            <div className="mt-auto flex flex-col gap-3">
              <Button
                size="lg"
                className="h-16 w-full text-[18px]"
                onClick={() => {
                  setQuote(null);
                  setAccount({ bankCode: account.bankCode, accountNumber: "", accountName: null });
                  go("bank");
                }}
              >
                Try another account
              </Button>
              {KEEP_ENABLED && (
                <Button
                  size="lg"
                  variant="outline"
                  className="h-16 w-full text-[18px]"
                  onClick={() => void startKeep()}
                >
                  Keep in dollars
                </Button>
              )}
              {error && <ErrorText>{error}</ErrorText>}
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <span className="h-12 w-12 animate-spin rounded-full border-4 border-ink/15 border-t-ink" />
            <p className="m-0 text-[20px] font-medium">
              {payout?.status === "processing"
                ? "Sending naira to your account…"
                : payout?.status === "quarantined"
                  ? "We're double-checking this payout"
                  : "Releasing your money…"}
            </p>
            <p className="m-0 text-[16px] text-ink/55">You can keep this page open.</p>
          </div>
        )}
      </div>
    </Screen>
  );
}
