import type { Metadata } from "next";
import { OnboardingFlow } from "@/components/ui/sign-up";
import { SessionProvider } from "@/lib/session";
import { WalletProvider } from "@/lib/wallet";

export const metadata: Metadata = {
  title: "Get started — Muuve",
  description: "Sign in with your wallet to send money as a link. Cleva sign-in is coming soon.",
};

export default function StartPage() {
  return (
    <SessionProvider>
      <WalletProvider>
        <OnboardingFlow />
      </WalletProvider>
    </SessionProvider>
  );
}
