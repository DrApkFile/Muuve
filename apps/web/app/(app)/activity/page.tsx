"use client";

import { useState } from "react";
import { ArrowUpRight, Link2, Send, Users } from "lucide-react";
import type { LinkSummary } from "@/lib/api";
import { useLinks, useNow } from "@/lib/hooks";
import { formatUsd, relativeDate, timeLeft } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, Pill, Spinner } from "@/components/app/kit";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { TintedIcon } from "@/components/app/TintedIcon";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "open", label: "Waiting" },
  { key: "settled", label: "Settled" },
] as const;

function statusPill(l: LinkSummary, now: number) {
  if (l.status === "pending") return <Pill>Confirming</Pill>;
  if (l.status === "cancelled") return <Pill>Cancelled</Pill>;
  if (l.status === "settled")
    return <Pill tone="sage">{l.claimed_slots ? "Settled" : "Returned"}</Pill>;
  const left = timeLeft(l.expires_at, now);
  return <Pill tone="lemon">{left && left.ms > 0 ? `${left.label} left` : "Returning"}</Pill>;
}

export default function ActivityPage() {
  const { links, loading } = useLinks();
  const now = useNow(30_000);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const shown = links.filter((l) => filter === "all" || l.status === filter);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="m-0 text-[44px] leading-[0.95] font-normal tracking-[-0.035em] md:text-[64px]">
          Activity
        </h1>
        <div className="flex rounded-full bg-paper/70 p-1.5 shadow-[0_1px_0_white_inset] backdrop-blur">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "h-10 rounded-full px-5 text-[15px] font-medium transition-colors",
                filter === f.key ? "bg-ink text-cream" : "hover:bg-paper",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <Card className="p-2 md:p-3">
        {loading ? (
          <div className="flex justify-center py-16 text-ink/50">
            <Spinner className="h-6 w-6" />
          </div>
        ) : shown.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia>
                <TintedIcon icon="share" tint="lemon" className="h-24 w-24" />
              </EmptyMedia>
              <EmptyTitle>{filter === "all" ? "No links yet" : "Nothing here"}</EmptyTitle>
              <EmptyDescription>
                Links you send show up here with each person&apos;s status.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button asChild>
                <a href="/send">
                  <Send aria-hidden="true" /> Send money
                </a>
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ul className="m-0 list-none p-0">
            {shown.map((l) => (
              <li key={l.id} className="border-b border-dashed border-ink/12 last:border-0">
                <a
                  href={`/activity/${l.id}`}
                  className="group flex items-center gap-4 rounded-[22px] px-3 py-4 transition-colors hover:bg-paper/80 md:px-4"
                >
                  <span
                    className={cn(
                      "flex h-12 w-12 shrink-0 items-center justify-center rounded-full",
                      l.kind === "batch"
                        ? "bg-[#262624] text-cream"
                        : "bg-lemon-100 text-lemon-700",
                    )}
                  >
                    {l.kind === "batch" ? (
                      <Users className="h-5 w-5" aria-hidden="true" />
                    ) : (
                      <Link2 className="h-5 w-5" aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[17px] font-medium tabular-nums">
                      {formatUsd(l.total_base_units, { cents: true })}
                    </span>
                    <span className="block text-[13px] text-ink/55">
                      {l.kind === "batch" ? `Batch · ${l.slot_count} people` : "1 person"} ·{" "}
                      {relativeDate(l.created_at, now)}
                    </span>
                  </span>
                  <span className="hidden w-40 shrink-0 sm:block">
                    <span className="flex h-2 overflow-hidden rounded-full bg-ink/[0.07]">
                      <span
                        className="bg-ink"
                        style={{ width: `${(l.claimed_slots / l.slot_count) * 100}%` }}
                      />
                    </span>
                    <span className="mt-1.5 block text-[12px] text-ink/50">
                      {l.claimed_slots} of {l.slot_count} claimed
                    </span>
                  </span>
                  <span className="shrink-0">{statusPill(l, now)}</span>
                  <ArrowUpRight
                    className="h-5 w-5 shrink-0 text-ink/30 transition-colors group-hover:text-ink"
                    aria-hidden="true"
                  />
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
