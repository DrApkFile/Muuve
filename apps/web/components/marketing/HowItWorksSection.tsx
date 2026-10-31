import HowItWorks, { type Step } from "@/components/ui/how-it-works";

const STEPS: Step[] = [
  {
    title: "Send",
    description:
      "Pick an amount, enter their phone number and add a note. You never need their bank details.",
    tone: "sage",
  },
  {
    title: "Share",
    description:
      "You get one link. Drop it in WhatsApp, in a private chat or straight into the family group.",
    tone: "lemon",
  },
  {
    title: "They verify",
    description:
      "They open the link, enter their number and type the code we text them. Nothing to install.",
    tone: "peach",
  },
  {
    title: "They choose",
    description:
      "Cash out to any Nigerian bank or OPay account in naira, or keep it in dollars for later.",
    tone: "rose",
  },
  {
    title: "Or it comes back",
    description:
      "Not claimed in 48 hours? The money returns to you automatically. You can recall it sooner.",
    tone: "sage",
  },
];

export function HowItWorksSection() {
  return (
    <section id="how-it-works" className="scroll-mt-6 bg-cream pt-20 md:pt-28">
      <div className="mx-auto max-w-6xl px-4 md:px-8">
        <p className="text-sm font-medium text-ink/55">How it works</p>
        <h2 className="mt-3 max-w-[16ch] text-[40px] leading-[0.95] font-medium tracking-[-0.035em] text-ink md:text-[64px]">
          A link that knows who it&apos;s for.
        </h2>
        <p className="mt-5 max-w-[46ch] text-base text-ink/60 md:text-lg">
          The person you&apos;re paying decides where the money lands, when they claim it. All you
          need is their number.
        </p>
      </div>
      <HowItWorks steps={STEPS} />
    </section>
  );
}
