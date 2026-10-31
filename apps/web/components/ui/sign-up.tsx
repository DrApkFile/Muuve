"use client";

import "./glass.css";
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { cva, type VariantProps } from "class-variance-authority";
import { AnimatePresence, motion, useInView, useReducedMotion, type Variants } from "motion/react";
import confetti from "canvas-confetti";
import bs58 from "bs58";
import type { Wallet } from "@wallet-standard/base";
import {
  ArrowLeft,
  ArrowRight,
  Handshake,
  Loader,
  PartyPopper,
  Wallet as WalletIcon,
} from "lucide-react";
import { api, type User } from "@/lib/api";
import { messageFor } from "@/lib/errors";
import { displayName, firstName, shortAddress } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";

// Sender sign-in, per docs/wallet-authentication.md: connect a Solana wallet, sign the
// server's one-time login message, and the API sets the account cookie. No phone or OTP.

type Step = "choose" | "cleva" | "wallet" | "signing" | "done";

// ---------- Backdrop: the hero's pastel panels, one per step ----------

type Tone = "lemon" | "peach" | "sage" | "rose";
const TONES: Record<Tone, { a: string; b: string; glow: string }> = {
  lemon: { a: "#F2ECDF", b: "#F4EBC6", glow: "246 222 104" },
  peach: { a: "#F8DCC7", b: "#F9CBA9", glow: "249 150 84" },
  sage: { a: "#E9EBE0", b: "#DFE9D4", glow: "150 206 150" },
  rose: { a: "#F0E4E6", b: "#ECD6E2", glow: "222 150 200" },
};
const STEP_TONE: Record<Step, Tone> = {
  choose: "lemon",
  cleva: "lemon",
  wallet: "peach",
  signing: "rose",
  done: "sage",
};

function Backdrop({ tone }: { tone: Tone }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {(Object.keys(TONES) as Tone[]).map((key) => {
        const t = TONES[key];
        return (
          <div
            key={key}
            className="absolute inset-0 scale-[1.08] transition-opacity duration-[900ms] ease-out"
            style={{
              opacity: key === tone ? 1 : 0,
              background: `radial-gradient(ellipse 62% 70% at 86% 76%, rgb(${t.glow} / 0.75), transparent 70%),
                radial-gradient(ellipse 46% 52% at 32% 105%, rgb(${t.glow} / 0.4), transparent 72%),
                linear-gradient(180deg, ${t.a}, ${t.b})`,
            }}
          />
        );
      })}
      <div className="grain absolute inset-0" />
    </div>
  );
}

// ---------- Blur fade ----------

function BlurFade({
  children,
  className,
  delay = 0,
  duration = 0.4,
  yOffset = 6,
  blur = "6px",
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  duration?: number;
  yOffset?: number;
  blur?: string;
}) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-50px" });
  const reduce = useReducedMotion();
  const variants: Variants = {
    hidden: { y: yOffset, opacity: 0, filter: `blur(${blur})` },
    visible: { y: 0, opacity: 1, filter: "blur(0px)" },
  };
  return (
    <motion.div
      ref={ref}
      initial={reduce ? false : "hidden"}
      animate={inView || reduce ? "visible" : "hidden"}
      variants={variants}
      transition={{ delay: 0.04 + delay, duration, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ---------- Glass button ----------

const glassButtonVariants = cva("relative isolate cursor-pointer rounded-full transition-all", {
  variants: {
    size: {
      default: "text-base font-medium",
      sm: "text-sm font-medium",
      lg: "text-lg font-medium",
      icon: "h-10 w-10",
    },
  },
  defaultVariants: { size: "default" },
});
const glassButtonTextVariants = cva("glass-button-text relative block select-none tracking-tight", {
  variants: {
    size: {
      default: "px-6 py-3.5",
      sm: "px-4 py-2",
      lg: "px-8 py-4",
      icon: "flex h-10 w-10 items-center justify-center",
    },
  },
  defaultVariants: { size: "default" },
});

export interface GlassButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof glassButtonVariants> {
  contentClassName?: string;
}

export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(
  ({ className, children, size, contentClassName, type = "button", ...props }, ref) => (
    <div className={cn("glass-button-wrap relative rounded-full", className)}>
      <button
        ref={ref}
        type={type}
        className={cn("glass-button relative z-10", glassButtonVariants({ size }))}
        {...props}
      >
        <span className={cn(glassButtonTextVariants({ size }), contentClassName)}>{children}</span>
      </button>
      <div className="glass-button-shadow pointer-events-none rounded-full" />
    </div>
  ),
);
GlassButton.displayName = "GlassButton";

// ---------- Small pieces ----------

function StepTitle({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <div className="w-full text-center">
      <BlurFade>
        <h1 className="m-0 text-[40px] leading-[0.95] font-medium tracking-[-0.035em] text-balance text-ink sm:text-5xl">
          {title}
        </h1>
      </BlurFade>
      {sub && (
        <BlurFade delay={0.15}>
          <p className="mx-auto mt-4 max-w-[36ch] text-[15px] text-ink/60">{sub}</p>
        </BlurFade>
      )}
    </div>
  );
}

function FieldError({ message }: { message: string | null }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.p
          role="alert"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="m-0 px-4 text-center text-sm font-medium text-destructive"
        >
          {message}
        </motion.p>
      )}
    </AnimatePresence>
  );
}

// ---------- Main flow ----------

export function OnboardingFlow() {
  const router = useRouter();
  const reduce = useReducedMotion();
  const session = useSession();
  const wallet = useWallet();
  const [step, setStep] = useState<Step>("choose");
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const next = () => {
    const target = new URLSearchParams(window.location.search).get("next");
    return target && target.startsWith("/") && !target.startsWith("//") ? target : "/home";
  };

  // Already signed in? Go straight to the app.
  useEffect(() => {
    if (!session.loading && session.user && step === "choose") router.replace(next());
  }, [session.loading, session.user]);

  // Confetti in the hero's four hues once signed in.
  useEffect(() => {
    if (step !== "done" || reduce || !canvasRef.current) return;
    const fire = confetti.create(canvasRef.current, { resize: true, useWorker: false });
    const base = {
      startVelocity: 30,
      spread: 360,
      ticks: 60,
      particleCount: 50,
      colors: ["#3FB874", "#E9C22E", "#F2772F", "#C564C4"],
    };
    fire({ ...base, origin: { x: 0, y: 1 }, angle: 60 });
    fire({ ...base, origin: { x: 1, y: 1 }, angle: 120 });
    return () => fire.reset();
  }, [step, reduce]);

  const go = (s: Step) => {
    setError(null);
    setStep(s);
  };

  async function signIn(target: Wallet) {
    setError(null);
    try {
      const address = await wallet.connect(target);
      go("signing");
      const challenge = await api<{ challenge_id: string; message: string }>(
        "/api/auth/wallet/challenge",
        { wallet_address: address },
      );
      const signature = await wallet.signMessage(new TextEncoder().encode(challenge.message));
      const res = await api<{ user: User }>("/api/auth/wallet/login", {
        challenge_id: challenge.challenge_id,
        signature: bs58.encode(signature),
      });
      session.setUser(res.user);
      setUser(res.user);
      go("done");
    } catch (err) {
      setStep("wallet");
      setError(messageFor(err));
    }
  }

  const back: Partial<Record<Step, () => void>> = {
    cleva: () => go("choose"),
    wallet: () => go("choose"),
  };
  const stepMotion = {
    initial: reduce ? false : { y: 8, opacity: 0 },
    animate: { y: 0, opacity: 1 },
    exit: reduce ? undefined : { opacity: 0, y: -6, filter: "blur(4px)" },
    transition: { duration: 0.3, ease: "easeOut" as const },
  };

  return (
    <div className="relative flex min-h-svh w-full flex-col overflow-hidden bg-cream text-ink">
      <Backdrop tone={STEP_TONE[step]} />
      <canvas
        ref={canvasRef}
        className="pointer-events-none fixed inset-0 z-[100] h-full w-full"
        aria-hidden="true"
      />

      <header className="relative z-20 flex h-16 items-center justify-between border-b border-ink/10 px-4 md:h-20 md:px-10">
        <a
          href="/"
          className="inline-flex items-center gap-2.5 text-[22px] font-semibold tracking-tight"
        >
          <span className="h-3 w-3 rounded-full bg-ink" aria-hidden="true" />
          muuve
        </a>
        {back[step] && (
          <button
            type="button"
            onClick={back[step]}
            className="inline-flex items-center gap-2 text-sm font-medium text-ink/60 transition-colors hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back
          </button>
        )}
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-[420px] min-w-0">
          <AnimatePresence mode="wait">
            {step === "choose" && (
              <motion.div key="choose" {...stepMotion} className="flex flex-col items-center gap-8">
                <StepTitle
                  title="Get started with Muuve"
                  sub="Send dollars home as a link. Sign in with the wallet you'll send from."
                />
                <BlurFade delay={0.25}>
                  <p className="m-0 text-sm font-medium text-ink/55">Continue with</p>
                </BlurFade>
                <BlurFade delay={0.4} className="flex flex-wrap items-center justify-center gap-4">
                  <GlassButton
                    size="sm"
                    onClick={() => go("cleva")}
                    contentClassName="flex items-center gap-2"
                  >
                    <Handshake className="h-5 w-5" aria-hidden="true" />
                    <span className="font-semibold text-ink">Cleva</span>
                  </GlassButton>
                  <GlassButton
                    size="sm"
                    onClick={() => go("wallet")}
                    contentClassName="flex items-center gap-2"
                  >
                    <WalletIcon className="h-5 w-5" aria-hidden="true" />
                    <span className="font-semibold text-ink">Wallet</span>
                  </GlassButton>
                </BlurFade>
                <BlurFade delay={0.55} className="flex w-full flex-col items-center gap-3">
                  <div className="flex w-full items-center gap-2">
                    <hr className="w-full border-ink/15" />
                    <span className="text-[11px] font-semibold tracking-wide whitespace-nowrap text-ink/45">
                      GOOD TO KNOW
                    </span>
                    <hr className="w-full border-ink/15" />
                  </div>
                  <p className="m-0 max-w-[38ch] text-center text-sm text-ink/55">
                    Received a payment? You don&apos;t need an account. Open the link you were sent
                    and verify your number.
                  </p>
                </BlurFade>
              </motion.div>
            )}

            {step === "cleva" && (
              <motion.div key="cleva" {...stepMotion} className="flex flex-col items-center gap-8">
                <BlurFade>
                  <span className="rounded-full border border-ink/20 bg-paper/60 px-3 py-1 text-xs font-semibold tracking-wide text-ink/70">
                    Partnership preview
                  </span>
                </BlurFade>
                <StepTitle
                  title="Continue with Cleva"
                  sub="With a Cleva partnership, you'd approve Muuve here and send straight from your Cleva USD balance. For this demo, sign in with a wallet and add test dollars."
                />
                <BlurFade delay={0.3} className="flex flex-col items-center gap-4">
                  <GlassButton
                    onClick={() => go("wallet")}
                    contentClassName="flex items-center gap-2"
                  >
                    Continue
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </GlassButton>
                  <p className="m-0 max-w-[32ch] text-center text-xs text-ink/50">
                    Muuve will never ask for your Cleva email, password, PIN or code.
                  </p>
                </BlurFade>
              </motion.div>
            )}

            {step === "wallet" && (
              <motion.div key="wallet" {...stepMotion} className="flex flex-col items-center gap-8">
                <StepTitle
                  title="Connect your wallet"
                  sub="You'll sign a one-time message to prove it's yours. It isn't a payment and costs nothing."
                />
                <BlurFade delay={0.3} className="flex w-full flex-col items-center gap-4">
                  {wallet.wallets.length === 0 ? (
                    <p className="m-0 max-w-[34ch] text-center text-sm text-ink/60">
                      No Solana wallet found in this browser. Install Phantom, Solflare or Backpack,
                      set it to Devnet, then reload this page.
                    </p>
                  ) : (
                    <div className="flex flex-wrap justify-center gap-3">
                      {wallet.wallets.map((w) => (
                        <GlassButton
                          key={w.name}
                          size="sm"
                          disabled={wallet.connecting}
                          onClick={() => void signIn(w)}
                          contentClassName="flex items-center gap-2"
                        >
                          <img src={w.icon} alt="" width={20} height={20} className="rounded-md" />
                          <span className="font-semibold text-ink">{w.name}</span>
                        </GlassButton>
                      ))}
                    </div>
                  )}
                  <FieldError message={error} />
                </BlurFade>
              </motion.div>
            )}

            {step === "signing" && (
              <motion.div
                key="signing"
                {...stepMotion}
                className="flex flex-col items-center gap-6"
              >
                <Loader className="h-10 w-10 animate-spin text-ink/70" aria-hidden="true" />
                <StepTitle
                  title="Check your wallet"
                  sub={
                    wallet.address
                      ? `Approve the sign-in message for ${shortAddress(wallet.address)}.`
                      : "Approve the sign-in message."
                  }
                />
              </motion.div>
            )}

            {step === "done" && user && (
              <motion.div key="done" {...stepMotion} className="flex flex-col items-center gap-8">
                <BlurFade>
                  <span className="flex h-16 w-16 items-center justify-center rounded-full bg-sage-100 text-sage-700">
                    <PartyPopper className="h-8 w-8" aria-hidden="true" />
                  </span>
                </BlurFade>
                <StepTitle
                  title={`Welcome, ${firstName(displayName(user))}`}
                  sub="You're signed in. Add test dollars, then send your first link."
                />
                <BlurFade delay={0.3}>
                  <GlassButton
                    onClick={() => router.push(next())}
                    contentClassName="flex items-center gap-2"
                  >
                    Continue
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </GlassButton>
                </BlurFade>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
