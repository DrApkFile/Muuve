"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { ArrowUpRight, Check, Loader, X } from "lucide-react";
import type { PayoutStatus, SlotStatus } from "@muuve/shared";
import { cn } from "@/lib/utils";
import { timeLeft } from "@/lib/format";

// ---------- Surfaces ----------

export function Card({
  className,
  children,
  tone = "paper",
}: {
  className?: string;
  children: ReactNode;
  tone?: "paper" | "ink" | "lemon" | "sage" | "peach" | "rose";
}) {
  return (
    <section
      className={cn(
        "relative min-w-0 overflow-hidden rounded-[28px] p-5 md:p-6",
        tone === "paper" &&
          "border border-white/70 bg-paper/70 shadow-[0_1px_0_rgba(255,255,255,0.9)_inset,0_20px_40px_-24px_rgba(80,60,30,0.25)] backdrop-blur-xl",
        tone === "ink" && "bg-[#262624] text-cream shadow-[0_24px_48px_-24px_rgba(13,13,12,0.6)]",
        tone === "lemon" && "bg-gradient-to-br from-lemon-50 to-lemon-100",
        tone === "sage" && "bg-gradient-to-br from-sage-50 to-sage-100",
        tone === "peach" && "bg-gradient-to-br from-peach-50 to-peach-100",
        tone === "rose" && "bg-gradient-to-br from-rose-50 to-rose-100",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardTitle({
  children,
  action,
  className,
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <h2 className="m-0 text-[22px] leading-tight font-medium tracking-[-0.02em]">{children}</h2>
      {action}
    </div>
  );
}

export function CornerLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      aria-label={label}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-paper shadow-[0_6px_16px_-8px_rgba(80,60,30,0.35)] transition-transform hover:scale-105 motion-reduce:hover:scale-100"
    >
      <ArrowUpRight className="h-5 w-5" aria-hidden="true" />
    </a>
  );
}

/** Warm grainy page backdrop: cream into lemon, like the hero panel at rest. */
export function AppBackdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10" aria-hidden="true">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 60% at 92% 88%, rgb(246 222 104 / 0.55), transparent 70%), radial-gradient(ellipse 50% 45% at 8% 100%, rgb(249 150 84 / 0.18), transparent 70%), linear-gradient(170deg, #f4f1ea 0%, #f6efdc 55%, #f4e7b8 100%)",
        }}
      />
      <div className="grain absolute inset-0" />
    </div>
  );
}

// ---------- Status ----------

type Tone = "lemon" | "sage" | "neutral" | "peach" | "rose" | "danger";

const toneClass: Record<Tone, string> = {
  lemon: "bg-lemon-100 text-lemon-700",
  sage: "bg-sage-100 text-sage-700",
  peach: "bg-peach-100 text-peach-700",
  rose: "bg-rose-100 text-rose-700",
  neutral: "bg-ink/[0.06] text-ink/65",
  danger: "bg-destructive/10 text-destructive",
};

export function Pill({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap",
        toneClass[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export const SLOT_META: Record<SlotStatus, { label: string; tone: Tone }> = {
  pending: { label: "Preparing", tone: "neutral" },
  funded: { label: "Waiting", tone: "lemon" },
  cashing_out: { label: "Cashing out…", tone: "lemon" },
  cashed_out: { label: "Cashed out", tone: "sage" },
  kept: { label: "Kept in dollars", tone: "sage" },
  recalled: { label: "Recalled", tone: "neutral" },
  returned: { label: "Returned to you", tone: "neutral" },
};

export function SlotStatusPill({
  status,
  expiresAt,
}: {
  status: SlotStatus;
  expiresAt?: string | null;
}) {
  const meta = SLOT_META[status];
  const left = status === "funded" ? timeLeft(expiresAt ?? null) : null;
  return (
    <Pill tone={meta.tone}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {meta.label}
      {left && left.ms > 0 && <span className="font-medium opacity-75">· {left.label}</span>}
    </Pill>
  );
}

export const PAYOUT_META: Record<PayoutStatus, { label: string; tone: Tone; done?: boolean }> = {
  quoted: { label: "Rate locked", tone: "lemon" },
  transferring: { label: "Releasing your money…", tone: "lemon" },
  processing: { label: "Sending naira…", tone: "lemon" },
  paid: { label: "Paid (simulated)", tone: "sage", done: true },
  failed: { label: "Couldn't send to that account", tone: "danger", done: true },
  resolved: { label: "Resolved", tone: "neutral", done: true },
  quarantined: { label: "Being checked", tone: "peach" },
};

// ---------- Inputs ----------

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-ink/60">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p role="alert" className="m-0 text-[13px] font-medium text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="m-0 text-[13px] text-ink/45">{hint}</p>
      ) : null}
    </div>
  );
}

export const inputClass =
  "h-12 w-full min-w-0 rounded-2xl border border-ink/10 bg-paper/80 px-4 text-[16px] text-ink placeholder:text-ink/35 transition-colors focus:border-ink/40 focus:bg-paper focus:outline-none aria-[invalid=true]:border-destructive/60";

// ---------- Feedback ----------

export function Spinner({ className }: { className?: string }) {
  return <Loader className={cn("h-4 w-4 animate-spin", className)} aria-hidden="true" />;
}

export function Notice({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-2xl px-4 py-3 text-sm", toneClass[tone], className)}>
      {children}
    </div>
  );
}

export type ProgressStep = { key: string; label: string };

/** Vertical step list for prepare → approve → send → confirm flows. */
export function StepProgress({
  steps,
  current,
  failed,
}: {
  steps: ProgressStep[];
  current: string;
  failed?: boolean;
}) {
  const index = steps.findIndex((s) => s.key === current);
  return (
    <ol className="m-0 flex list-none flex-col gap-3 p-0">
      {steps.map((step, i) => {
        const done = i < index || current === "done";
        const active = i === index && current !== "done";
        return (
          <li key={step.key} className="flex items-center gap-3">
            <span
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                done && "border-transparent bg-lemon-500 text-ink",
                active && !failed && "border-ink/20 bg-paper",
                active && failed && "border-destructive/40 bg-destructive/10 text-destructive",
                !done && !active && "border-ink/10 text-ink/30",
              )}
            >
              {done ? (
                <Check className="h-4 w-4" aria-hidden="true" />
              ) : active && !failed ? (
                <Spinner />
              ) : active && failed ? (
                <X className="h-4 w-4" aria-hidden="true" />
              ) : (
                <span className="text-xs font-semibold">{i + 1}</span>
              )}
            </span>
            <span
              className={cn(
                "text-[15px]",
                done ? "text-ink/45 line-through" : active ? "font-medium" : "text-ink/45",
              )}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------- Sheet ----------

export function Sheet({
  open,
  onClose,
  title,
  children,
  dismissible = true,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  children: ReactNode;
  dismissible?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) onClose();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open, dismissible, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div
        className="absolute inset-0 bg-ink/30 backdrop-blur-sm"
        onClick={dismissible ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative max-h-[92svh] w-full overflow-y-auto rounded-t-[28px] bg-cream p-6 shadow-2xl outline-none sm:max-w-md sm:rounded-[28px]"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <h2 id={titleId} className="m-0 text-2xl font-medium tracking-[-0.02em]">
            {title}
          </h2>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink/5 hover:bg-ink/10"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- Countdown ring ----------

export function ExpiryRing({
  expiresAt,
  windowMs = 172_800_000,
  now,
  size = 190,
}: {
  expiresAt: string;
  windowMs?: number;
  now: number;
  size?: number;
}) {
  const left = Math.max(0, new Date(expiresAt).getTime() - now);
  const progress = Math.min(1, left / windowMs);
  const r = 44;
  const c = 2 * Math.PI * r;
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className="block" aria-hidden="true">
      <circle
        cx="50"
        cy="50"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.18"
        strokeWidth="1.2"
        strokeDasharray="0.6 2.2"
      />
      <circle
        cx="50"
        cy="50"
        r={r}
        fill="none"
        stroke="#E9C22E"
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={`${progress * c} ${c}`}
        transform="rotate(-90 50 50)"
        className="transition-[stroke-dasharray] duration-700"
      />
      <text
        x="50"
        y="50"
        textAnchor="middle"
        className="fill-current"
        style={{ fontSize: 15, fontWeight: 500, letterSpacing: "-0.03em" }}
      >
        {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}
      </text>
      <text
        x="50"
        y="62"
        textAnchor="middle"
        className="fill-current"
        style={{ fontSize: 5.2, opacity: 0.55 }}
      >
        until it returns
      </text>
    </svg>
  );
}
