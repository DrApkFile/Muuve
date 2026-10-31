"use client";

import { useState, type ReactNode } from "react";
import { Wallet as WalletIcon } from "lucide-react";
import { useSession } from "@/lib/session";
import { useWallet } from "@/lib/wallet";
import { shortAddress } from "@/lib/format";
import { messageFor } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Notice } from "./kit";

/** Renders children only when the wallet that owns this session is connected. */
export function WalletGate({ children, purpose }: { children: ReactNode; purpose: string }) {
  const { user } = useSession();
  const wallet = useWallet();
  const [error, setError] = useState<string | null>(null);
  const expected = user?.wallet_address ?? null;

  if (wallet.address && (!expected || wallet.address === expected)) return <>{children}</>;

  return (
    <div className="flex flex-col gap-4 rounded-[24px] border border-dashed border-ink/20 p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-lemon-100 text-lemon-700">
          <WalletIcon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <p className="m-0 font-medium">Connect your wallet {purpose}</p>
          <p className="m-0 mt-0.5 text-sm text-ink/55">
            {expected
              ? `Use the wallet you logged in with (${shortAddress(expected)}).`
              : "Use the wallet you fund payments from."}
          </p>
        </div>
      </div>
      {wallet.address && expected && wallet.address !== expected && (
        <Notice tone="peach">
          Your wallet is on {shortAddress(wallet.address)}. Switch to {shortAddress(expected)} in
          your wallet app.
        </Notice>
      )}
      {wallet.wallets.length === 0 ? (
        <p className="m-0 text-sm text-ink/60">
          No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then reload
          this page.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {wallet.wallets.map((w) => (
            <Button
              key={w.name}
              variant="soft"
              disabled={wallet.connecting}
              onClick={async () => {
                setError(null);
                try {
                  await wallet.connect(w);
                } catch (err) {
                  setError(messageFor(err));
                }
              }}
            >
              <img src={w.icon} alt="" width={20} height={20} className="rounded-md" />
              {w.name}
            </Button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
