"use client";

import type { CSSProperties } from "react";
import { LazyMotion, domAnimation, m, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

export type Tone = "sage" | "lemon" | "peach" | "rose";

const TONES: Record<Tone, { bg: string; text: string; border: string }> = {
  sage: { bg: "bg-sage-50", text: "text-sage-700", border: "border-sage-100" },
  lemon: { bg: "bg-lemon-50", text: "text-lemon-700", border: "border-lemon-100" },
  peach: { bg: "bg-peach-50", text: "text-peach-700", border: "border-peach-100" },
  rose: { bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-100" },
};

const Pin = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    className={className}
  >
    <path d="M16 3a1 1 0 0 1 .117 1.993l-.117 .007v4.764l1.894 3.789a1 1 0 0 1 .1 .331l.006 .116v2a1 1 0 0 1 -.883 .993l-.117 .007h-4v4a1 1 0 0 1 -1.993 .117l-.007 -.117v-4h-4a1 1 0 0 1 -.993 -.883l-.007 -.117v-2a1 1 0 0 1 .06 -.34l.046 -.107l1.894 -3.791v-4.762a1 1 0 0 1 -.117 -1.993l.117 -.007h8z" />
  </svg>
);

interface CardProps {
  number: string;
  title: string;
  description: string;
  tone: Tone;
  className?: string;
  rotate?: string;
  index: number;
}

const Card = ({ number, title, description, tone, className, rotate, index }: CardProps) => {
  const colors = TONES[tone];
  const reduce = useReducedMotion();
  return (
    <m.li
      initial={reduce ? false : { opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.6, delay: index * 0.06, ease: [0.22, 1, 0.36, 1] }}
      className={cn("relative w-full list-none md:w-[280px]", className)}
    >
      <div
        className={cn(
          "transition-transform duration-300 hover:z-30 hover:scale-105 motion-reduce:hover:scale-100",
          rotate,
        )}
      >
        <div className="rounded-[25px] border border-ink/5 bg-paper p-2 shadow-[0_14px_30px_-8px_rgba(80,60,30,0.18)]">
          <Pin className={cn("z-20 mx-auto mb-6 h-8 w-8", colors.text)} />
          <div
            className={cn(
              "relative flex h-full flex-col overflow-hidden rounded-[15px] border p-[15px]",
              colors.bg,
              colors.border,
            )}
          >
            <span
              className={cn(
                "mb-5 text-4xl font-medium tracking-[-0.03em] tabular-nums",
                colors.text,
              )}
            >
              {number}
            </span>
            <h3 className="mb-[10px] text-2xl leading-none font-semibold tracking-[-0.02em] text-ink">
              {title}
            </h3>
            <p className="text-sm/5 tracking-tight text-ink/60">{description}</p>
          </div>
        </div>
      </div>
    </m.li>
  );
};

export interface Step {
  title: string;
  description: string;
  tone?: Tone;
}

export interface StepPosition {
  className?: string;
  rotate?: string;
}

export interface HowItWorksProps {
  steps: Step[];
  className?: string;
  stepPositions?: StepPosition[];
}

const DEFAULT_CARD_POSITIONS: StepPosition[] = [
  { className: "md:absolute md:top-0 md:left-[15%]", rotate: "rotate-1 md:rotate-6" },
  { className: "md:absolute md:top-[120px] md:right-[15%]", rotate: "-rotate-1 md:-rotate-6" },
  { className: "md:absolute md:top-[450px] md:left-[15%]", rotate: "rotate-1 md:rotate-6" },
  { className: "md:absolute md:top-[570px] md:right-[10%]", rotate: "-rotate-1 md:-rotate-6" },
  { className: "md:absolute md:top-[850px] md:left-[15%]", rotate: "rotate-1 md:rotate-6" },
];

const HEIGHTS = [0, 400, 450, 800, 900, 1130];

export default function HowItWorks({ steps, className, stepPositions }: HowItWorksProps) {
  const positions = stepPositions ?? DEFAULT_CARD_POSITIONS;
  const height = HEIGHTS[Math.min(steps.length, HEIGHTS.length - 1)];
  const reduce = useReducedMotion();

  // Dashed path that threads card to card, in a 1000-wide viewBox.
  const segments = [
    "M 290 150 C 500 150, 550 270, 710 270",
    " C 850 270, 500 350, 290 450",
    " C 290 600, 550 720, 750 720",
    " C 950 720, 500 800, 290 850",
  ];
  const pathD = segments.slice(0, Math.max(0, steps.length - 1)).join("");

  return (
    <LazyMotion features={domAnimation}>
      <div className={cn("relative px-4 max-md:pt-10 max-md:pb-24 md:px-8 md:py-20", className)}>
        {/* Ruled notebook lines, fading out to the cream at both sides. */}
        <div
          className="pointer-events-none absolute inset-0 mt-1 opacity-[0.07]"
          style={{
            backgroundImage: "linear-gradient(#0d0d0c 1px, transparent 1px)",
            backgroundSize: "100% 32px",
          }}
        />
        <div className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-cream" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-cream" />

        <div className="relative z-10 mx-auto max-w-6xl">
          <ol
            className="relative mx-auto m-0 flex h-auto w-full max-w-[1000px] flex-col space-y-8 p-0 md:block md:h-[var(--md-height)] md:space-y-0"
            style={{ "--md-height": `${height}px` } as CSSProperties}
          >
            {steps.length > 1 && (
              <svg
                className="pointer-events-none absolute top-0 left-0 z-0 hidden h-full w-full md:block"
                viewBox={`0 0 1000 ${height}`}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <m.path
                  d={pathD}
                  stroke="currentColor"
                  className="text-ink/25"
                  strokeWidth="2"
                  strokeDasharray="8 6"
                  fill="none"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  initial={{ strokeDashoffset: 0 }}
                  animate={reduce ? undefined : { strokeDashoffset: -140 }}
                  transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                />
              </svg>
            )}

            {steps.map((step, index) => {
              const position = positions[index % positions.length];
              return (
                <Card
                  key={step.title}
                  index={index}
                  number={`0${index + 1}`}
                  title={step.title}
                  description={step.description}
                  tone={step.tone ?? "sage"}
                  rotate={position?.rotate}
                  className={position?.className}
                />
              );
            })}
          </ol>
        </div>
      </div>
    </LazyMotion>
  );
}
