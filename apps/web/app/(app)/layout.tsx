import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { WalletProvider } from "@/lib/wallet";
import { AppShell } from "@/components/app/AppShell";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <WalletProvider>
        <AppShell>{children}</AppShell>
      </WalletProvider>
    </SessionProvider>
  );
}
