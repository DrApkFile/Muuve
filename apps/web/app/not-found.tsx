import type { Metadata } from "next";
import { NotFound } from "@/components/ui/not-found-2";

export const metadata: Metadata = {
  title: "Page not found — Muuve",
};

export default function NotFoundPage() {
  return <NotFound />;
}
