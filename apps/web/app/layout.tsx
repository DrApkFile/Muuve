import type { Metadata, Viewport } from "next";
import { Inter_Tight } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const interTight = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-inter-tight",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Muuve — send money to a person",
  description:
    "Turn dollars into a link you share on WhatsApp. They verify their number, then cash out to naira or keep dollars. Unclaimed money comes back in 48 hours.",
};

export const viewport: Viewport = {
  themeColor: "#FBF6EF",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={interTight.variable}>
      {/* Browser extensions (e.g. Grammarly) add attributes to <body> before hydration. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
