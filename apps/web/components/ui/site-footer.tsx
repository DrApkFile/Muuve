"use client";

import { ChevronRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

// Where a claimed payment can land. Text only: no bank logos or branding.
const DESTINATIONS = [
  { label: "OPay", from: "#F9CBA9", to: "#F2772F" },
  { label: "PalmPay", from: "#DFE9D4", to: "#3FB874" },
  { label: "Moniepoint", from: "#F4EBC6", to: "#E9C22E" },
  { label: "Kuda", from: "#ECD6E2", to: "#C564C4" },
  { label: "Any Nigerian bank", from: "#DFE9D4", to: "#3FB874" },
  { label: "Naira today", from: "#F4EBC6", to: "#E9C22E" },
  { label: "Dollars for later", from: "#ECD6E2", to: "#C564C4" },
  { label: "Shared on WhatsApp", from: "#F9CBA9", to: "#F2772F" },
];

function Marquee() {
  return (
    <div
      className="group/marquee relative overflow-hidden py-2"
      style={{
        maskImage: "linear-gradient(to right, transparent, #000 12%, #000 88%, transparent)",
        WebkitMaskImage: "linear-gradient(to right, transparent, #000 12%, #000 88%, transparent)",
      }}
    >
      <ul className="m-0 flex w-max animate-marquee list-none gap-4 p-0 group-hover/marquee:[animation-play-state:paused] motion-reduce:animate-none">
        {[...DESTINATIONS, ...DESTINATIONS].map((d, i) => (
          <li
            key={i}
            aria-hidden={i >= DESTINATIONS.length || undefined}
            className="group relative flex h-24 w-40 shrink-0 items-center justify-center overflow-hidden rounded-full border border-ink/10 bg-paper shadow-sm transition-all hover:border-ink/20"
          >
            <div
              className="absolute inset-0 scale-150 opacity-0 transition-all duration-500 group-hover:scale-100 group-hover:opacity-100"
              style={{ background: `linear-gradient(135deg, ${d.from}, ${d.to})` }}
            />
            <span className="relative px-4 text-center text-[15px] leading-tight font-semibold tracking-[-0.01em] text-ink/70 transition-colors group-hover:text-ink">
              {d.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SiteFooter({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  return (
    <footer className={cn("bg-cream px-4 pt-10 pb-10 md:px-8 md:pt-16", className)}>
      <div className="relative mx-auto flex h-[600px] w-full max-w-[1400px] flex-col overflow-hidden rounded-[32px] border border-ink/10 bg-paper shadow-[0_40px_100px_-20px_rgba(80,60,30,0.08)] md:rounded-[48px]">
        {/* Video turned grey, then tinted through the hero's four hues. */}
        <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden select-none">
          <video
            className="h-full w-full scale-105 object-cover object-[70%_50%] grayscale brightness-[1.04]"
            src="/footer/footer.mp4"
            autoPlay
            loop
            muted
            playsInline
            preload="metadata"
            aria-hidden="true"
          />
          <div className="footer-tint absolute inset-0 mix-blend-color" />
          <div className="absolute inset-0 bg-cream mix-blend-multiply opacity-40" />
          <div className="grain absolute inset-0" />
        </div>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="relative z-20 flex flex-1 flex-col items-start px-6 pt-10 md:px-16 md:pt-16"
        >
          <h2 className="m-0 text-[38px] leading-[0.98] font-medium tracking-[-0.035em] text-ink md:text-[56px]">
            You don&apos;t send money
            <br />
            to an account.
            <br />
            You send it to a person.
          </h2>
          <p className="mt-5 max-w-[44ch] text-[14px] text-ink/60 md:text-[15px]">
            Turn dollars into a link, share it on WhatsApp, and let them choose naira or dollars
            when they claim it. Anything unclaimed comes back to you.
          </p>
          <motion.a
            href="/start"
            whileHover={reduce ? undefined : { scale: 1.04 }}
            whileTap={reduce ? undefined : { scale: 0.97 }}
            className="mt-7 inline-flex h-12 items-center rounded-full bg-ink px-6 text-[14px] font-semibold text-cream"
          >
            Get started
          </motion.a>
        </motion.div>

        <div className="absolute bottom-6 left-1/2 z-30 -translate-x-1/2 md:bottom-10">
          <motion.nav
            aria-label="Footer"
            initial={reduce ? false : { opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="flex items-center rounded-full border border-ink/10 bg-paper/90 px-1.5 py-1.5 shadow-[0_12px_40px_rgba(80,60,30,0.1)] backdrop-blur-2xl"
          >
            <a
              href="/"
              aria-label="Muuve home"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-ink/5 bg-paper shadow-sm"
            >
              <span className="h-2.5 w-2.5 rounded-full bg-ink" />
            </a>
            <a
              href="#how-it-works"
              className="px-3 text-[12px] font-semibold whitespace-nowrap text-ink/55 transition-colors hover:text-ink md:px-4"
            >
              How it works
            </a>
            <a
              href="#safety"
              className="px-3 text-[12px] font-semibold text-ink/55 transition-colors hover:text-ink max-sm:hidden md:px-4"
            >
              Safety
            </a>
            <a
              href="/start"
              className="flex items-center gap-1 rounded-full border border-ink/10 bg-paper px-5 py-2 text-[12px] font-semibold whitespace-nowrap text-ink shadow-sm transition-all hover:border-ink/25"
            >
              Get started
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </motion.nav>
        </div>
      </div>

      <div className="mx-auto mt-10 max-w-[1400px]">
        <Marquee />
      </div>

      <div className="mx-auto mt-10 flex max-w-[1400px] flex-col gap-2 px-2 text-[13px] text-ink/45 md:flex-row md:items-center md:justify-between">
        <p className="m-0 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-ink" aria-hidden="true" />
          <span className="font-semibold text-ink/70">muuve</span>
          <span>© 2026</span>
        </p>
      </div>
    </footer>
  );
}
