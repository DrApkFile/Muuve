import { CompassIcon, HomeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { TintedIcon } from "@/components/app/TintedIcon";

export function NotFound() {
  return (
    <div className="relative flex min-h-svh w-full items-center justify-center overflow-hidden">
      {/* The hero's rose panel: radial glows on a soft gradient, with grain. */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(ellipse 62% 70% at 86% 76%, rgb(222 150 200 / 0.6), transparent 70%), radial-gradient(ellipse 46% 52% at 32% 105%, rgb(222 150 200 / 0.3), transparent 72%), linear-gradient(180deg, #F0E4E6, #ECD6E2)",
        }}
      />
      <div className="grain pointer-events-none absolute inset-0" aria-hidden="true" />

      <a
        href="/"
        className="absolute top-5 left-5 inline-flex items-center gap-2 text-[22px] font-semibold tracking-tight md:top-7 md:left-10"
      >
        <span className="h-3 w-3 rounded-full bg-ink" aria-hidden="true" />
        muuve
      </a>

      <Empty className="relative">
        <EmptyHeader className="max-w-md">
          <TintedIcon icon="split" tint="rose" className="mb-2 h-24 w-24 md:h-28 md:w-28" />
          <EmptyTitle className="mask-b-from-20% mask-b-to-80% text-[150px] leading-none font-semibold tracking-[-0.06em] md:text-[200px]">
            404
          </EmptyTitle>
          <EmptyDescription className="-mt-6 text-[17px] text-ink/70 md:-mt-8">
            The page you&apos;re looking for might have been
            <br className="max-sm:hidden" /> moved, or it never existed.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild size="lg">
              <a href="/">
                <HomeIcon data-icon="inline-start" />
                Go home
              </a>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href="/#how-it-works">
                <CompassIcon data-icon="inline-start" />
                How Muuve works
              </a>
            </Button>
          </div>
          <p className="m-0 text-[13px] text-ink/50">
            Opening a payment link? Use the full link exactly as it was sent to you.
          </p>
        </EmptyContent>
      </Empty>
    </div>
  );
}
