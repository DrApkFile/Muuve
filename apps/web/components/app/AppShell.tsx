"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Copy, LogOut, Plus, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession } from "@/lib/session";
import { useWallet } from "@/lib/wallet";
import { displayName, shortAddress } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { AppBackdrop, Notice, Spinner } from "./kit";
import { GlassLens } from "./GlassLens";
import { FundSheet } from "./FundSheet";

const NAV = [
  { href: "/home", label: "Home" },
  { href: "/send", label: "Send" },
  { href: "/activity", label: "Activity" },
  { href: "/cashout", label: "Cash out" },
];

function AccountMenu() {
  const { user, logout } = useSession();
  const wallet = useWallet();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!user) return null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Account"
        className="flex h-11 w-11 items-center justify-center rounded-full bg-paper/80 shadow-[0_1px_0_white_inset] backdrop-blur transition-colors hover:bg-paper"
      >
        <UserRound className="h-5 w-5" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute top-13 right-0 z-40 w-64 rounded-3xl border border-ink/10 bg-cream p-2 shadow-xl">
          <div className="px-3 py-2">
            <p className="m-0 text-[15px] font-semibold">{displayName(user)}</p>
            {user.wallet_address && (
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(user.wallet_address!)}
                className="mt-0.5 inline-flex items-center gap-1.5 text-[13px] text-ink/55 hover:text-ink"
              >
                Wallet {shortAddress(user.wallet_address)}
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={async () => {
              await logout();
              await wallet.disconnect();
              router.replace("/start");
            }}
            className="flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-left text-[15px] hover:bg-ink/5"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, loading, logout } = useSession();
  const wallet = useWallet();
  const pathname = usePathname();
  const router = useRouter();
  const [funding, setFunding] = useState(false);

  useEffect(() => {
    // Signed out, or signed in without a verified phone: finish onboarding first.
    if (!loading && (!user || !user.phone_linked))
      router.replace(`/start?next=${encodeURIComponent(pathname)}`);
  }, [loading, user, pathname, router]);

  // The session belongs to one wallet. If the connected wallet changes, don't act as it.
  const mismatch =
    !!user?.wallet_address && !!wallet.address && wallet.address !== user.wallet_address;

  return (
    <div className="relative min-h-svh text-ink">
      <AppBackdrop />
      <div className="mx-auto w-full max-w-[1440px] px-4 pt-4 pb-16 md:px-8 md:pt-7">
        <header className="flex flex-wrap items-center gap-3 md:flex-nowrap">
          <a
            href="/home"
            className="inline-flex h-12 items-center gap-2 rounded-full border-[1.4px] border-ink/70 px-5 text-[22px] font-semibold tracking-[-0.02em]"
          >
            <span className="h-2.5 w-2.5 rounded-full bg-ink" aria-hidden="true" />
            muuve
          </a>

          <nav
            aria-label="App"
            className="order-last -mx-4 flex w-[calc(100%+2rem)] gap-1 overflow-x-auto px-4 pb-1 md:order-none md:mx-0 md:ml-auto md:w-auto md:overflow-visible md:rounded-full md:bg-paper/70 md:p-1.5 md:shadow-[0_1px_0_white_inset] md:backdrop-blur"
          >
            {NAV.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative inline-flex h-11 shrink-0 items-center rounded-full px-5 text-[15px] font-medium transition-colors",
                    active ? "" : "bg-paper/70 hover:bg-paper md:bg-transparent",
                  )}
                >
                  {active && <GlassLens group="nav" />}
                  <span className="relative">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2 md:ml-0">
            <Button variant="soft" onClick={() => setFunding(true)} disabled={!user}>
              <Plus aria-hidden="true" />
              <span className="max-sm:hidden">Add money</span>
            </Button>
            <AccountMenu />
          </div>
        </header>

        {mismatch && (
          <Notice tone="peach" className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <span>
              Your wallet switched to {shortAddress(wallet.address!)}. This session belongs to{" "}
              {shortAddress(user!.wallet_address!)}. Switch back in your wallet, or log out.
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await logout();
                router.replace("/start");
              }}
            >
              Log out
            </Button>
          </Notice>
        )}

        <main className="mt-8 md:mt-12">
          {loading || !user ? (
            <div className="flex min-h-[50svh] items-center justify-center text-ink/50">
              <Spinner className="h-6 w-6" />
            </div>
          ) : (
            children
          )}
        </main>
      </div>
      <FundSheet open={funding} onClose={() => setFunding(false)} />
    </div>
  );
}
