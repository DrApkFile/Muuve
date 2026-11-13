import { Hero } from "@/components/marketing/Hero";
import { GetPaidSection } from "@/components/marketing/GetPaidSection";
import { HowItWorksSection } from "@/components/marketing/HowItWorksSection";
import { SiteFooter } from "@/components/ui/site-footer";

export default function LandingPage() {
  return (
    <>
      <main>
        <Hero />
        <HowItWorksSection />
        <GetPaidSection />
      </main>
      <SiteFooter />
    </>
  );
}
