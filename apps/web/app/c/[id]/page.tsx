import type { Metadata } from "next";
import { ClaimFlow } from "@/components/claim/ClaimFlow";

export const metadata: Metadata = {
  title: "You've got money — Muuve",
  description: "Open this link and verify your number to receive your money.",
  robots: { index: false, follow: false },
};

export default async function ClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ClaimFlow linkId={id} />;
}
