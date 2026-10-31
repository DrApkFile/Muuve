// Money is integer base units (6 decimals for dollars, kobo for naira). No floats anywhere.
const USD_DECIMALS = 6n;
const USD_UNIT = 10n ** USD_DECIMALS;

function groupThousands(digits: string) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "12500000" → "$12.50" (cents shown only when non-zero unless `cents` is true). */
export function formatUsd(baseUnits: string | bigint, opts: { cents?: boolean } = {}) {
  const value = BigInt(baseUnits);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / USD_UNIT;
  const cents = (abs % USD_UNIT) / 10_000n; // floor to cents
  const showCents = opts.cents || cents !== 0n;
  const text = `$${groupThousands(whole.toString())}${showCents ? `.${cents.toString().padStart(2, "0")}` : ""}`;
  return negative ? `-${text}` : text;
}

/** "1824000" kobo → "₦18,240" */
export function formatNgn(kobo: string | bigint) {
  const value = BigInt(kobo);
  const naira = value / 100n;
  const rest = value % 100n;
  return `₦${groupThousands(naira.toString())}${rest ? `.${rest.toString().padStart(2, "0")}` : ""}`;
}

/** User input "12.5" → "12500000"; null when not a positive amount with ≤2 decimals. */
export function parseUsd(input: string): string | null {
  const text = input.trim().replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const value = BigInt(whole!) * USD_UNIT + BigInt(fraction.padEnd(2, "0")) * 10_000n;
  return value > 0n ? value.toString() : null;
}

/** Base units → editable input text, e.g. "12500000" → "12.50". */
export function usdInput(baseUnits: string | bigint) {
  const value = BigInt(baseUnits);
  const cents = (value % USD_UNIT) / 10_000n;
  return `${value / USD_UNIT}${cents ? `.${cents.toString().padStart(2, "0")}` : ""}`;
}

/** Split a total across n people in whole cents; remainder cents go to the first rows. */
export function splitEqually(totalBaseUnits: string, n: number): string[] {
  const totalCents = BigInt(totalBaseUnits) / 10_000n;
  const count = BigInt(n);
  const each = totalCents / count;
  const remainder = totalCents % count;
  return Array.from({ length: n }, (_, i) =>
    ((each + (BigInt(i) < remainder ? 1n : 0n)) * 10_000n).toString(),
  );
}

export function maskPhone(e164: string) {
  const last4 = e164.slice(-4);
  const cc = e164.startsWith("+234") ? "+234" : e164.startsWith("+1") ? "+1" : e164.slice(0, 3);
  return `${cc} ••• ${last4}`;
}

export function shortAddress(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** Wallet-only accounts are created as "Wallet sender"; show something friendlier. */
export function displayName(user: { display_name: string; wallet_address: string | null }) {
  if (user.display_name === "Wallet sender" && user.wallet_address)
    return shortAddress(user.wallet_address);
  return user.display_name;
}

export function firstName(name: string) {
  return name.split(/\s+/)[0] ?? name;
}

export function timeLeft(expiresAt: string | null, now = Date.now()) {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return { ms: 0, label: "Expired" };
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const label =
    h > 0 ? `${h}h ${m.toString().padStart(2, "0")}m` : `${m}m ${s.toString().padStart(2, "0")}s`;
  return { ms, label };
}

export function relativeDate(iso: string, now = Date.now()) {
  const diff = now - new Date(iso).getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function randomHex(bytes: number) {
  const arr = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
