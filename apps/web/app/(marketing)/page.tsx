import { Hero } from "@/components/marketing/Hero";
import { HowItWorksSection } from "@/components/marketing/HowItWorksSection";
import { SiteFooter } from "@/components/ui/site-footer";

export default function LandingPage() {
  return (
    <>
      <main>
        <Hero />
        <HowItWorksSection />
      </main>
      <SiteFooter />
    </>
  );
}
