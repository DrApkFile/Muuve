import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

// The hero's glossy icons, greyed and re-tinted with a colour-blend layer clipped to the icon.
const ICONS = {
  send: "/hero/send.webp",
  share: "/hero/share.webp",
  claim: "/hero/claim.webp",
  split: "/hero/split.webp",
} as const;

export const TINTS = {
  sage: "#3FB874",
  lemon: "#E9C22E",
  peach: "#F2772F",
  rose: "#C564C4",
} as const;

export function TintedIcon({
  icon,
  tint,
  className,
}: {
  icon: keyof typeof ICONS;
  tint: keyof typeof TINTS;
  className?: string;
}) {
  const src = ICONS[icon];
  return (
    <span
      aria-hidden="true"
      className={cn("relative isolate inline-block shrink-0", className)}
      style={{ "--mask": `url(${src})` } as CSSProperties}
    >
      <img
        src={src}
        alt=""
        width={320}
        height={320}
        decoding="async"
        className="block h-full w-full [filter:grayscale(1)_brightness(1.1)_contrast(1.08)]"
      />
      <span
        className="absolute inset-0 mix-blend-color [mask:var(--mask)_center/contain_no-repeat] [-webkit-mask:var(--mask)_center/contain_no-repeat]"
        style={{ background: TINTS[tint] }}
      />
    </span>
  );
}
