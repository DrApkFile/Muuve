"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Check, Copy, Eye, MessageCircle, Share2 } from "lucide-react";
import { useLink, useNow } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import { useWallet } from "@/lib/wallet";
import { messageFor } from "@/lib/errors";
import { formatUsd, maskPhone, timeLeft } from "@/lib/format";
import {
  claimKeyFromSignature,
  claimMessage,
  claimUrl,
  recallClaimSecret,
  rememberClaimSecret,
} from "@/lib/solana";
import { Button } from "@/components/ui/button";
import { Card, Notice, SlotStatusPill, Spinner } from "@/components/app/kit";
import { TintedIcon } from "@/components/app/TintedIcon";
import { WalletGate } from "@/components/app/WalletGate";

function shareText(opts: { name: string | null; amount?: string; batch: boolean; url: string }) {
  const who = opts.name ? `${opts.name} sent you` : "You've been sent";
  return opts.batch
    ? `${who} money on Muuve 💸 Open it, verify your number and get your share. Available for 48 hours: ${opts.url}`
    : `${who} ${opts.amount} on Muuve 💸 Open it and verify your number to receive it. Available for 48 hours: ${opts.url}`;
}

export default function SharePage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useSession();
  const wallet = useWallet();
  const { link, loading, notFound } = useLink(id);
  const now = useNow(30_000);
  const [secret, setSecret] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => setSecret(recallClaimSecret(id) ?? null), [id]);

  async function reveal() {
    if (!link) return;
    setRevealing(true);
    setError(null);
    try {
      const sig = await wallet.signMessage(claimMessage(link.link_id_hex));
      const key = await claimKeyFromSignature(sig);
      rememberClaimSecret(id, key.secret);
      setSecret(key.secret);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setRevealing(false);
    }
  }

  if (loading)
    return (
      <div className="flex justify-center py-20 text-ink/50">
        <Spinner className="h-6 w-6" />
      </div>
    );
  if (notFound || !link)
    return <Notice tone="danger">We couldn&apos;t find that link in your account.</Notice>;

  const url = secret ? claimUrl(link.id, secret) : null;
  const name =
    user && user.display_name !== "Wallet sender" ? user.display_name.split(/\s+/)[0]! : null;
  const text = url
    ? shareText({
        name,
        amount: formatUsd(link.total_base_units),
        batch: link.kind === "batch",
        url,
      })
    : "";
  const left = timeLeft(link.expires_at, now);
  const open = link.status === "open";

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-6">
      <div className="flex flex-col items-start gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="m-0 text-[15px] text-ink/55">
            {open ? "Your link is ready" : link.status === "pending" ? "Still confirming" : "Link"}
          </p>
          <h1 className="m-0 mt-2 text-[44px] leading-[0.95] font-normal tracking-[-0.035em] md:text-[64px]">
            {formatUsd(link.total_base_units, { cents: true })} ·{" "}
            {link.kind === "batch" ? `${link.slot_count} people` : "1 person"}
          </h1>
        </div>
        {open && left && (
          <span className="rounded-full bg-lemon-500 px-4 py-2 text-sm font-semibold">
            Returns to you in {left.label}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1.3fr_1fr]">
        <Card tone="lemon" className="flex flex-col gap-5">
          <TintedIcon
            icon="share"
            tint="lemon"
            className="pointer-events-none absolute -right-6 -bottom-8 h-44 w-44"
          />
          <p className="relative m-0 max-w-[36ch] text-ink/70">
            Share this one link in WhatsApp. Only the numbers you entered can claim, after they
            verify with a code.
          </p>

          {link.status === "pending" ? (
            <Notice className="relative">
              We&apos;re still confirming this payment. Refresh in a moment before sharing.
            </Notice>
          ) : !open ? (
            <Notice className="relative">This link is settled. Nothing is left to claim.</Notice>
          ) : url ? (
            <>
              <div className="relative flex items-center gap-2 rounded-2xl bg-paper/80 p-2 pl-4">
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink/70">
                  {url.replace(/#k=.*/, "#k=••••••••")}
                </span>
                <Button
                  size="sm"
                  variant={copied ? "sage" : "default"}
                  onClick={async () => {
                    await navigator.clipboard.writeText(url);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1800);
                  }}
                >
                  {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <div className="relative flex flex-wrap gap-2">
                <Button asChild size="lg">
                  <a
                    href={`https://wa.me/?text=${encodeURIComponent(text)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <MessageCircle aria-hidden="true" /> Share on WhatsApp
                  </a>
                </Button>
                {typeof navigator !== "undefined" && "share" in navigator && (
                  <Button
                    size="lg"
                    variant="outline"
                    onClick={() => void navigator.share({ text }).catch(() => {})}
                  >
                    <Share2 aria-hidden="true" /> More
                  </Button>
                )}
              </div>
              <p className="relative m-0 text-[13px] text-ink/50">
                The part after #k= is the key to this money. Share it only with the people you paid.
              </p>
            </>
          ) : (
            <div className="relative flex flex-col gap-3">
              <p className="m-0 text-sm text-ink/60">
                Muuve doesn&apos;t store the link&apos;s key. Your wallet recreates it when you
                approve.
              </p>
              <WalletGate purpose="to show this link">
                <Button onClick={reveal} disabled={revealing} className="self-start">
                  {revealing ? <Spinner /> : <Eye aria-hidden="true" />}
                  Show link
                </Button>
              </WalletGate>
              {error && (
                <p role="alert" className="m-0 text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
          )}
        </Card>

        <Card>
          <h2 className="m-0 text-[20px] font-medium tracking-[-0.02em]">Who it&apos;s for</h2>
          {link.note && <p className="m-0 mt-1 text-sm text-ink/55">“{link.note}”</p>}
          <ul className="m-0 mt-4 flex list-none flex-col divide-y divide-dashed divide-ink/15 p-0">
            {link.slots.map((s) => (
              <li key={s.slot_index} className="flex items-center justify-between gap-3 py-3">
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {s.label || maskPhone(s.recipient_phone_e164)}
                  </span>
                  {s.label && (
                    <span className="block text-[13px] text-ink/50">
                      {maskPhone(s.recipient_phone_e164)}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="font-medium tabular-nums">
                    {formatUsd(s.amount_base_units, { cents: true })}
                  </span>
                  <SlotStatusPill status={s.status} />
                </span>
              </li>
            ))}
          </ul>
          <Button asChild variant="soft" className="mt-4 w-full">
            <a href={`/activity/${link.id}`}>Track and recall</a>
          </Button>
        </Card>
      </div>
    </div>
  );
}
