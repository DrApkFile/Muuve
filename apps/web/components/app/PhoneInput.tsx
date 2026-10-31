"use client";

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { cn } from "@/lib/utils";

export const COUNTRIES: { code: CountryCode; dial: string; name: string }[] = [
  { code: "NG", dial: "+234", name: "Nigeria" },
  { code: "US", dial: "+1", name: "United States" },
  { code: "GB", dial: "+44", name: "United Kingdom" },
  { code: "CA", dial: "+1", name: "Canada" },
  { code: "GH", dial: "+233", name: "Ghana" },
];

export type PhoneValue = { country: CountryCode; number: string };

/** E.164 for a valid number, otherwise null. */
export function toE164(value: PhoneValue): string | null {
  const parsed = parsePhoneNumberFromString(value.number, value.country);
  return parsed?.isValid() ? parsed.number : null;
}

export function PhoneInput({
  id,
  value,
  onChange,
  invalid,
  autoFocus,
  className,
  size = "default",
}: {
  id?: string;
  value: PhoneValue;
  onChange(value: PhoneValue): void;
  invalid?: boolean;
  autoFocus?: boolean;
  className?: string;
  size?: "default" | "lg";
}) {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 items-center rounded-2xl border border-ink/10 bg-paper/80 transition-colors focus-within:border-ink/40 focus-within:bg-paper",
        invalid && "border-destructive/60",
        size === "lg" ? "h-14" : "h-12",
        className,
      )}
    >
      <select
        aria-label="Country"
        value={value.country}
        onChange={(e) => onChange({ ...value, country: e.target.value as CountryCode })}
        className="h-full shrink-0 cursor-pointer appearance-none rounded-l-2xl bg-transparent pr-2 pl-4 text-[15px] font-semibold focus:outline-none"
      >
        {COUNTRIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.code} {c.dial}
          </option>
        ))}
      </select>
      <span className="h-5 w-px shrink-0 bg-ink/15" aria-hidden="true" />
      <input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        placeholder={value.country === "NG" ? "801 234 5678" : "Phone number"}
        value={value.number}
        onChange={(e) => onChange({ ...value, number: e.target.value.replace(/[^\d\s()+-]/g, "") })}
        className={cn(
          "h-full w-0 min-w-0 grow bg-transparent px-3 text-ink placeholder:text-ink/35 focus:outline-none",
          size === "lg" ? "text-[18px]" : "text-[16px]",
        )}
      />
    </div>
  );
}
