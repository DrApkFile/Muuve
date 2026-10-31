"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, BellRing, Share2, Undo2 } from "lucide-react";
import type { TimelineEvent } from "@/lib/api";
import { useLink, useNow } from "@/lib/hooks";
import { formatUsd, maskPhone, relativeDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardTitle,
  ExpiryRing,
  Notice,
  Pill,
  SlotStatusPill,
  Spinner,
} from "@/components/app/kit";
import { RecallSheet, type RecallTarget } from "@/components/app/RecallSheet";

const OPERATION_KIND: Record<string, string> = {
  create: "Payment locked in",
  recall: "Recall",
  intent: "A recipient started claiming",
  claim_keep: "A recipient kept dollars",
  claim_cashout: "A recipient cashed out",
  expire: "Unclaimed money returned",
  fund: "Balance topped up",
};

function describe(e: TimelineEvent) {
  const kind = typeof e.payload.kind === "string" ? OPERATION_KIND[e.payload.kind] : undefined;
  switch (e.type) {
    case "link.prepared":
      return "Link created";
    case "operation.prepared":
      return kind ? `${kind}: prepared` : "Prepared";
    case "operation.finalized":
      return kind ? `${kind}: confirmed` : "Confirmed";
    case "operation.failed":
      return kind ? `${kind}: didn't go through` : "Didn't go through";
    case "operation.replacement_prepared":
      return "Refreshed and ready to approve again";
    case "payout.retried":
      return "Cash-out retried to another account";
    default:
      if (e.type.startsWith("payout.")) return `Cash-out ${e.type.slice(7).replace(/_/g, " ")}`;
      return e.type.replace(/[._]/g, " ");
  }
}

export default function LinkDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { link, loading, notFound, reload } = useLink(id);
  const now = useNow(1000);
  const [recall, setRecall] = useState<RecallTarget | null>(null);

  if (loading)
    return (
      <div className="flex justify-center py-20 text-ink/50">
        <Spinner className="h-6 w-6" />
      </div>
    );
  if (notFound || !link)
    return <Notice tone="danger">We couldn&apos;t find that link in your account.</Notice>;

  const funded = link.slots.filter((s) => s.status === "funded");
  const fundedTotal = funded.reduce((sum, s) => sum + BigInt(s.amount_base_units), 0n);
  const expired = !!link.expires_at && new Date(link.expires_at).getTime() <= now;
  const canRecall = link.status === "open" && !expired;
  const claimed = link.slots.filter((s) => s.status === "kept" || s.status === "cashed_out").length;

  return (
    <div className="flex flex-col gap-6">
      <a
        href="/activity"
        className="inline-flex items-center gap-2 self-start text-sm text-ink/60 hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Activity
      </a>

      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill>{link.kind === "batch" ? `Batch · ${link.slot_count} people` : "1 person"}</Pill>
            <Pill tone={link.status === "open" ? "lemon" : "sage"}>
              {link.status === "open"
                ? "Waiting"
                : link.status === "settled"
                  ? "Settled"
                  : link.status}
            </Pill>
          </div>
          <h1 className="m-0 mt-3 text-[44px] leading-[0.95] font-normal tracking-[-0.035em] tabular-nums md:text-[64px]">
            {formatUsd(link.total_base_units, { cents: true })}
          </h1>
          {link.note && <p className="m-0 mt-2 text-ink/60">“{link.note}”</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {link.status === "open" && (
            <Button asChild variant="outline">
              <a href={`/send/${link.id}`}>
                <Share2 aria-hidden="true" /> Share again
              </a>
            </Button>
          )}
          {canRecall && funded.length > 0 && (
            <Button
              variant="danger"
              onClick={() =>
                setRecall({
                  who: funded.length === 1 ? "they" : "everyone who hasn't claimed",
                  amount: fundedTotal.toString(),
                })
              }
            >
              <Undo2 aria-hidden="true" /> Recall all unclaimed
            </Button>
          )}
        </div>
      </div>

      {link.reminder_due && link.status === "open" && (
        <Notice tone="lemon" className="flex items-center gap-3">
          <BellRing className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span>
            {funded.length === 1 ? "Someone hasn't" : `${funded.length} people haven't`} claimed
            yet. A quick reminder in WhatsApp usually helps.
          </span>
        </Notice>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardTitle
            action={
              <span className="text-[34px] leading-none font-light tracking-[-0.04em] tabular-nums">
                {claimed}/{link.slot_count}
              </span>
            }
          >
            Recipients
          </CardTitle>
          <ul className="m-0 mt-4 flex list-none flex-col divide-y divide-dashed divide-ink/15 p-0">
            {link.slots.map((s) => (
              <li key={s.slot_index} className="flex flex-wrap items-center gap-3 py-4">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-sm font-semibold">
                  {(s.label || "•").slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {s.label || maskPhone(s.recipient_phone_e164)}
                  </span>
                  <span className="block text-[13px] text-ink/50">
                    {s.label ? `${maskPhone(s.recipient_phone_e164)} · ` : ""}
                    {formatUsd(s.amount_base_units, { cents: true })}
                  </span>
                </span>
                <SlotStatusPill status={s.status} expiresAt={link.expires_at} />
                {canRecall && s.status === "funded" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setRecall({
                        slotIndex: s.slot_index,
                        who: s.label || "they",
                        amount: s.amount_base_units,
                      })
                    }
                  >
                    Recall
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>

        <div className="flex flex-col gap-4">
          {link.status === "open" && link.expires_at && !expired && (
            <Card tone="lemon" className="flex flex-col items-center">
              <ExpiryRing expiresAt={link.expires_at} now={now} size={170} />
              <p className="m-0 mt-2 text-center text-sm text-ink/60">
                {formatUsd(fundedTotal, { cents: true })} returns to you if not claimed.
              </p>
            </Card>
          )}
          {expired && link.status === "open" && (
            <Notice tone="peach">
              The 48 hours are up. Unclaimed money is on its way back to your balance.
            </Notice>
          )}
          <Card tone="ink">
            <h2 className="m-0 text-[20px] font-medium tracking-[-0.02em]">Timeline</h2>
            <ol className="m-0 mt-4 flex list-none flex-col gap-4 p-0">
              {link.timeline.slice(0, 12).map((e) => (
                <li key={e.id} className="flex items-start gap-3">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-lemon-500" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] first-letter:uppercase">{describe(e)}</span>
                    <span className="block text-[12px] text-cream/45">
                      {relativeDate(e.created_at, now)}
                    </span>
                  </span>
                </li>
              ))}
              {link.timeline.length === 0 && (
                <li className="text-sm text-cream/55">Nothing yet.</li>
              )}
            </ol>
          </Card>
        </div>
      </div>

      <RecallSheet
        linkId={link.id}
        target={recall}
        onClose={() => setRecall(null)}
        onDone={() => void reload()}
      />
    </div>
  );
}
