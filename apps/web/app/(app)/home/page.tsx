"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  Banknote,
  Check,
  ChevronDown,
  Link2,
  Plus,
  Send,
  Users,
  Wallet,
} from "lucide-react";
import type { LinkSummary } from "@/lib/api";
import { useBalance, useLinks, useNow } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import { displayName, firstName, formatNgn, formatUsd, relativeDate, timeLeft } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardTitle, CornerLink, ExpiryRing, Pill } from "@/components/app/kit";
import { FundSheet } from "@/components/app/FundSheet";
import { TintedIcon } from "@/components/app/TintedIcon";

const DAY = 86_400_000;
const DAYS = ["S", "M", "T", "W", "T", "F", "S"];

function useStats(links: LinkSummary[]) {
  return useMemo(() => {
    let slots = 0;
    let claimed = 0;
    let unclaimedOpen = 0;
    for (const l of links) {
      if (l.status === "pending" || l.status === "cancelled") continue;
      slots += l.slot_count;
      claimed += l.claimed_slots;
      if (l.status === "open") unclaimedOpen += l.slot_count - l.claimed_slots;
    }
    const back = Math.max(0, slots - claimed - unclaimedOpen);
    const pct = (n: number) => (slots ? Math.round((n / slots) * 100) : 0);
    return {
      slots,
      claimed,
      unclaimedOpen,
      back,
      pct: { claimed: pct(claimed), waiting: pct(unclaimedOpen), back: pct(back) },
      sent: links.filter((l) => l.status !== "pending" && l.status !== "cancelled").length,
    };
  }, [links]);
}

function SegmentBar({ stats }: { stats: ReturnType<typeof useStats> }) {
  const segments = [
    { key: "claimed", label: "Claimed", value: stats.pct.claimed, className: "bg-ink text-cream" },
    {
      key: "waiting",
      label: "Waiting",
      value: stats.pct.waiting,
      className: "bg-lemon-500 text-ink",
    },
    {
      key: "back",
      label: "Back to you",
      value: stats.pct.back,
      className:
        "text-ink bg-[repeating-linear-gradient(135deg,rgba(13,13,12,0.09)_0_2px,transparent_2px_9px)] bg-paper/50",
    },
  ];
  const empty = stats.slots === 0;
  return (
    <div className="flex w-full max-w-[720px] items-end gap-1.5">
      {(empty ? [{ ...segments[2]!, value: 100, label: "No claims yet" }] : segments)
        .filter((s) => s.value > 0)
        .map((s) => (
          <div key={s.key} className="min-w-[72px]" style={{ flexGrow: Math.max(s.value, 12) }}>
            <p className="m-0 mb-2 pl-1 text-[15px] text-ink/75">{s.label}</p>
            <div
              className={cn(
                "flex h-14 items-center rounded-full px-5 text-sm font-medium tabular-nums",
                s.className,
              )}
            >
              {empty ? "0%" : `${s.value}%`}
            </div>
          </div>
        ))}
      <div className="w-[96px] shrink-0">
        <p className="m-0 mb-2 pl-1 text-[15px] text-ink/75">People</p>
        <div className="flex h-14 items-center rounded-full border-[1.4px] border-ink/50 px-5 text-sm font-medium tabular-nums">
          {stats.slots}
        </div>
      </div>
    </div>
  );
}

function BigStat({ icon, value, label }: { icon: ReactNode; value: string; label: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-end gap-2">
        <span className="mb-3 flex h-7 w-7 items-center justify-center rounded-lg bg-ink/[0.07] text-ink/70">
          {icon}
        </span>
        <span className="text-[56px] leading-none font-light tracking-[-0.05em] tabular-nums md:text-[76px]">
          {value}
        </span>
      </div>
      <p className="m-0 mt-1 pl-9 text-[15px] text-ink/70">{label}</p>
    </div>
  );
}

function WeekBars({ links, now }: { links: LinkSummary[]; now: number }) {
  const days = useMemo(() => {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const start = today.getTime() - 6 * DAY;
    const buckets = Array.from({ length: 7 }, (_, i) => ({
      date: new Date(start + i * DAY),
      total: 0n,
    }));
    for (const l of links) {
      if (l.status === "pending" || l.status === "cancelled") continue;
      const i = Math.floor((new Date(l.created_at).getTime() - start) / DAY);
      if (i >= 0 && i < 7) buckets[i]!.total += BigInt(l.total_base_units);
    }
    return buckets;
  }, [links, now]);
  const max = days.reduce((m, d) => (d.total > m ? d.total : m), 0n);
  const week = days.reduce((s, d) => s + d.total, 0n);
  return (
    <>
      <div className="mt-3 flex items-end gap-3">
        <span className="text-[44px] leading-none font-light tracking-[-0.04em] tabular-nums">
          {formatUsd(week)}
        </span>
        <span className="pb-1 text-sm leading-tight text-ink/60">
          Sent
          <br />
          this week
        </span>
      </div>
      <div className="relative mt-6 flex h-[150px] items-end justify-between px-1">
        <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-ink/15" />
        {days.map((d, i) => {
          const isToday = i === 6;
          const height = max > 0n ? Number((d.total * 100n) / max) : 0;
          return (
            <div
              key={i}
              className="relative flex h-full w-6 flex-col items-center justify-end gap-2"
            >
              {isToday && d.total > 0n && (
                <span className="absolute -top-2 rounded-full bg-lemon-500 px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap">
                  {formatUsd(d.total)}
                </span>
              )}
              <div
                className={cn(
                  "w-[7px] rounded-full",
                  d.total === 0n
                    ? "bg-[repeating-linear-gradient(135deg,rgba(13,13,12,0.18)_0_1px,transparent_1px_4px)]"
                    : isToday
                      ? "bg-lemon-500"
                      : "bg-ink",
                )}
                style={{ height: `${Math.max(height * 0.72, 14)}%` }}
              />
              <span
                className={cn("h-1.5 w-1.5 rounded-full", isToday ? "bg-lemon-500" : "bg-ink")}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex justify-between px-1 text-[13px] text-ink/50">
        {days.map((d, i) => (
          <span key={i} className="w-6 text-center">
            {DAYS[d.date.getDay()]}
          </span>
        ))}
      </div>
    </>
  );
}

function Timeline48({ links, now }: { links: LinkSummary[]; now: number }) {
  const open = links
    .filter((l) => l.status === "open" && l.expires_at)
    .filter((l) => new Date(l.expires_at!).getTime() > now)
    .slice(0, 6);
  const span = 2 * DAY;
  const ticks = [0, 12, 24, 36, 48];
  return (
    <>
      <CardTitle
        action={
          <span className="rounded-full bg-paper px-3 py-1.5 text-[13px] font-medium shadow-sm">
            Next 48 hours
          </span>
        }
      >
        Returns timeline
      </CardTitle>
      <div className="relative mt-6">
        <div className="grid grid-cols-5 text-[13px] text-ink/45">
          {ticks.map((h) => (
            <span
              key={h}
              className={cn(h === 48 && "text-right", h > 0 && h < 48 && "text-center")}
            >
              {h === 0 ? "Now" : `+${h}h`}
            </span>
          ))}
        </div>
        <div className="relative mt-3 min-h-[176px]">
          {ticks.map((h) => (
            <div
              key={h}
              className="absolute top-0 bottom-0 border-l border-dashed border-ink/15"
              style={{ left: `${(h / 48) * 100}%` }}
            />
          ))}
          {open.length === 0 ? (
            <p className="absolute inset-x-0 top-1/2 m-0 -translate-y-1/2 text-center text-sm text-ink/45">
              Nothing waiting. Unclaimed money shows here before it returns.
            </p>
          ) : (
            open.map((l, i) => {
              const at = new Date(l.expires_at!).getTime() - now;
              const pos = Math.min(1, at / span);
              const waiting = l.slot_count - l.claimed_slots;
              return (
                <a
                  key={l.id}
                  href={`/activity/${l.id}`}
                  className={cn(
                    "absolute flex h-[50px] max-w-[260px] min-w-[180px] -translate-x-full flex-col justify-center rounded-2xl px-4 text-left transition-transform hover:-translate-y-0.5 motion-reduce:hover:translate-y-0",
                    l.kind === "batch"
                      ? "bg-[#262624] text-cream"
                      : "bg-paper shadow-[0_8px_20px_-12px_rgba(80,60,30,0.4)]",
                  )}
                  style={{ left: `${Math.max(pos * 100, 40)}%`, top: `${(i % 3) * 58}px` }}
                >
                  <span className="truncate text-[14px] font-medium">
                    {formatUsd(l.total_base_units)} ·{" "}
                    {l.kind === "batch" ? `${l.slot_count} people` : "1 person"}
                  </span>
                  <span className="truncate text-[12px] opacity-60">
                    {waiting} waiting · returns in {timeLeft(l.expires_at, now)?.label}
                  </span>
                </a>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}

const ACTIONS = [
  {
    title: "Send to one person",
    body: "Enter their number and an amount. You get one link to share on WhatsApp.",
    href: "/send",
    cta: "Send money",
  },
  {
    title: "Batch payment",
    body: "Pay up to 10 people from one link, each with their own amount.",
    href: "/send?mode=batch",
    cta: "Start a batch",
  },
  {
    title: "Cash out to a bank",
    body: "Move dollars from your balance to any Nigerian bank or OPay account.",
    href: "/cashout",
    cta: "Cash out",
  },
  {
    title: "How returns work",
    body: "Anything not claimed in 48 hours comes back to you. You can recall it sooner from Activity.",
    href: "/activity",
    cta: "See activity",
  },
];

function QuickActions() {
  const [open, setOpen] = useState(0);
  return (
    <ul className="m-0 list-none p-0">
      {ACTIONS.map((a, i) => {
        const expanded = open === i;
        return (
          <li key={a.title} className="border-b border-dashed border-ink/15 last:border-0">
            <button
              type="button"
              onClick={() => setOpen(expanded ? -1 : i)}
              aria-expanded={expanded}
              className="flex w-full items-center justify-between gap-3 py-4 text-left text-[17px]"
            >
              {a.title}
              <ChevronDown
                className={cn("h-5 w-5 shrink-0 transition-transform", expanded && "rotate-180")}
                aria-hidden="true"
              />
            </button>
            {expanded && (
              <div className="flex flex-col items-start gap-3 pb-5">
                <p className="m-0 text-sm text-ink/60">{a.body}</p>
                <Button asChild size="sm" variant="outline">
                  <a href={a.href}>{a.cta}</a>
                </Button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function RecentLinks({ links, now }: { links: LinkSummary[]; now: number }) {
  const shown = links.filter((l) => l.status !== "pending" && l.status !== "cancelled").slice(0, 6);
  const settled = links.filter((l) => l.status === "settled").length;
  return (
    <Card tone="ink" className="flex h-full flex-col">
      <div className="flex items-start justify-between">
        <h2 className="m-0 text-[22px] font-medium tracking-[-0.02em]">Your links</h2>
        <span className="text-[40px] leading-none font-light tracking-[-0.04em] tabular-nums">
          {settled}/{shown.length ? links.filter((l) => l.status !== "pending").length : 0}
        </span>
      </div>
      <p className="m-0 mt-1 text-[13px] text-cream/50">settled</p>
      {shown.length === 0 ? (
        <div className="flex flex-1 flex-col items-start justify-end gap-4 pt-10">
          <p className="m-0 text-sm text-cream/60">
            No links yet. Your first one takes about a minute.
          </p>
          <Button asChild variant="lemon" size="sm">
            <a href="/send">
              <Send aria-hidden="true" /> Send money
            </a>
          </Button>
        </div>
      ) : (
        <ul className="m-0 mt-6 flex list-none flex-col gap-4 p-0">
          {shown.map((l) => {
            const done = l.status === "settled";
            return (
              <li key={l.id}>
                <a href={`/activity/${l.id}`} className="group flex items-center gap-3">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-cream/10">
                    {l.kind === "batch" ? (
                      <Users className="h-5 w-5" aria-hidden="true" />
                    ) : (
                      <Link2 className="h-5 w-5" aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-[15px]",
                        done && "text-cream/50 line-through",
                      )}
                    >
                      {formatUsd(l.total_base_units)} ·{" "}
                      {l.kind === "batch"
                        ? `${l.claimed_slots} of ${l.slot_count} claimed`
                        : l.claimed_slots
                          ? "Claimed"
                          : "Waiting"}
                    </span>
                    <span className="block text-[12px] text-cream/45">
                      {relativeDate(l.created_at, now)}
                      {l.status === "open" && l.expires_at
                        ? ` · ${timeLeft(l.expires_at, now)?.label} left`
                        : ""}
                    </span>
                  </span>
                  {done ? (
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-lemon-500 text-ink">
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                  ) : (
                    <span className="h-5 w-5 rounded-full bg-cream/15" aria-hidden="true" />
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      )}
      {shown.length > 0 && (
        <a
          href="/activity"
          className="mt-auto inline-flex items-center gap-1 pt-6 text-sm text-cream/70 hover:text-cream"
        >
          All activity <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
        </a>
      )}
    </Card>
  );
}

export default function HomePage() {
  const { user } = useSession();
  const balance = useBalance();
  const { links, loading } = useLinks();
  const now = useNow(30_000);
  const stats = useStats(links);
  const [funding, setFunding] = useState(false);
  const soonest = links
    .filter((l) => l.status === "open" && l.expires_at && new Date(l.expires_at).getTime() > now)
    .sort((a, b) => new Date(a.expires_at!).getTime() - new Date(b.expires_at!).getTime())[0];

  const name = user ? firstName(displayName(user)) : "";
  const bal = balance.data?.amount_base_units ?? null;

  return (
    <div className="flex flex-col gap-8 md:gap-10">
      <div className="flex flex-col gap-8 xl:flex-row xl:items-end xl:justify-between">
        <div className="flex min-w-0 flex-col gap-8">
          <h1 className="m-0 text-[44px] leading-[0.95] font-normal tracking-[-0.035em] md:text-[68px]">
            Welcome in, {name}
          </h1>
          <SegmentBar stats={stats} />
        </div>
        <div className="flex flex-wrap gap-x-10 gap-y-4">
          <BigStat
            icon={<Wallet className="h-4 w-4" />}
            value={bal === null ? "—" : formatUsd(bal).replace(/\.\d+$/, "")}
            label="Balance"
          />
          <BigStat icon={<Link2 className="h-4 w-4" />} value={String(stats.sent)} label="Links" />
          <BigStat
            icon={<Users className="h-4 w-4" />}
            value={String(stats.claimed)}
            label="Claimed"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {/* Balance */}
        <Card tone="sage" className="flex min-h-[340px] flex-col">
          <TintedIcon
            icon="send"
            tint="sage"
            className="pointer-events-none absolute -top-6 -right-8 h-48 w-48 opacity-90"
          />
          <p className="relative m-0 text-[15px] font-medium text-ink/60">Balance</p>
          <p className="relative m-0 mt-2 text-[52px] leading-none font-light tracking-[-0.045em] tabular-nums">
            {bal === null ? "—" : formatUsd(bal, { cents: true })}
          </p>
          {balance.data && (
            <p className="relative m-0 mt-2 text-sm text-ink/60">
              ≈ {formatNgn(balance.data.estimated_ngn_kobo)}
              <span className="text-ink/45">
                {" "}
                · mock rate ₦{balance.data.rate_ngn_per_usd.replace(/\.?0+$/, "")}/$1
              </span>
            </p>
          )}
          <div className="relative mt-auto flex flex-wrap gap-2 pt-8">
            <Button asChild>
              <a href="/send">
                <Send aria-hidden="true" /> Send
              </a>
            </Button>
            <Button variant="outline" onClick={() => setFunding(true)}>
              <Plus aria-hidden="true" /> Add money
            </Button>
          </div>
          <p className="relative m-0 mt-3 text-[12px] text-ink/45">Demo network · test dollars</p>
        </Card>

        {/* This week */}
        <Card className="min-h-[340px]">
          <CardTitle action={<CornerLink href="/activity" label="See activity" />}>
            Sending
          </CardTitle>
          <WeekBars links={links} now={now} />
        </Card>

        {/* Next return */}
        <Card className="flex min-h-[340px] flex-col">
          <CardTitle
            action={
              soonest ? (
                <CornerLink href={`/activity/${soonest.id}`} label="Open link" />
              ) : undefined
            }
          >
            Next return
          </CardTitle>
          {soonest ? (
            <>
              <div className="flex flex-1 items-center justify-center py-2">
                <ExpiryRing expiresAt={soonest.expires_at!} now={now} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <Pill tone="lemon">
                  {soonest.slot_count - soonest.claimed_slots} of {soonest.slot_count} waiting
                </Pill>
                <Button asChild size="sm" variant="soft">
                  <a href={`/send/${soonest.id}`}>Share again</a>
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <TintedIcon icon="claim" tint="lemon" className="h-24 w-24" />
              <p className="m-0 max-w-[24ch] text-sm text-ink/55">
                {loading ? "Loading…" : "Nothing waiting to be claimed right now."}
              </p>
            </div>
          )}
        </Card>

        {/* Your links (dark) */}
        <div className="md:row-span-2 xl:col-start-4 xl:row-span-2 xl:row-start-1">
          <RecentLinks links={links} now={now} />
        </div>

        {/* Quick actions */}
        <Card>
          <QuickActions />
        </Card>

        {/* Timeline */}
        <Card className="md:col-span-2 xl:col-span-2">
          <Timeline48 links={links} now={now} />
        </Card>
      </div>

      {balance.error && !balance.data ? (
        <p className="m-0 text-sm text-ink/50">
          <Banknote className="mr-1 inline h-4 w-4" aria-hidden="true" />
          We couldn&apos;t load your balance just now.
        </p>
      ) : null}
      <FundSheet open={funding} onClose={() => setFunding(false)} />
    </div>
  );
}
