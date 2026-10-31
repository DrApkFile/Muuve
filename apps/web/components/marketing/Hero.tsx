"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import styles from "./hero.module.css";

// One entry per cycling verb. Icon, tint and panel layer move together.
const WORDS = [
  { word: "Send", icon: "/hero/send.webp", tint: "#3FB874", layer: styles.layerSage },
  { word: "Share", icon: "/hero/share.webp", tint: "#E9C22E", layer: styles.layerLemon },
  { word: "Claim", icon: "/hero/claim.webp", tint: "#F2772F", layer: styles.layerPeach },
  { word: "Split", icon: "/hero/split.webp", tint: "#C564C4", layer: styles.layerRose },
] as const;

const SLOT_MS = 1750;
const ENTER_MS = 500;
const LEAVE_MS = 420;
const ICON_DELAY_MS = 60;
const PANEL_FADE_MS = 770;
const FLASH_INDEX = 3; // "Split": the Get started button fills while it holds
const STILL_INDEX = 0; // reduced motion shows "Send"

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
const easeInCubic = (x: number) => x ** 3;
const smoothstep = (x: number) => x * x * (3 - 2 * x);

export function Hero() {
  const clockRef = useRef<HTMLDivElement>(null);
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const iconRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const layerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const ctaRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    const words = wordRefs.current;
    const icons = iconRefs.current;
    const layers = layerRefs.current;
    const cta = ctaRef.current;
    const n = WORDS.length;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      words.forEach((el, j) => {
        if (el) el.style.opacity = j === STILL_INDEX ? "1" : "0";
      });
      layers.forEach((el, j) => {
        if (el) el.style.opacity = j === STILL_INDEX ? "1" : "0";
      });
      return;
    }

    // Everything reads this one clock, so a frame-by-frame recorder can seek it.
    const clock = clockRef.current?.animate([], { duration: 1e9 });
    if (!clock) return;

    const render = (t: number) => {
      const cycle = t % (SLOT_MS * n);
      const i = Math.floor(cycle / SLOT_MS);
      const s = cycle - i * SLOT_MS;

      words.forEach((el, j) => {
        if (el && j !== i) el.style.opacity = "0";
      });

      const word = words[i];
      if (word) {
        let opacity = 1;
        let y = 0;
        let blurPx = 0;
        let scale = 1;
        if (s < ENTER_MS) {
          const p = easeOutCubic(s / ENTER_MS);
          opacity = p;
          y = 0.32 * (1 - p);
          blurPx = 10 * (1 - p);
          scale = 0.96 + 0.04 * p;
        } else if (s > SLOT_MS - LEAVE_MS) {
          const q = easeInCubic((s - (SLOT_MS - LEAVE_MS)) / LEAVE_MS);
          opacity = 1 - q;
          y = -0.16 * q;
          blurPx = 8 * q;
        }
        word.style.opacity = String(opacity);
        word.style.transform = `translateY(${y}em) scale(${scale})`;
        // Blur is specced in px at the 172px headline size; em keeps it proportional.
        word.style.filter = blurPx > 0.01 ? `blur(${blurPx / 172}em)` : "none";
      }

      const icon = icons[i];
      if (icon) {
        const p = easeOutCubic(clamp01((s - ICON_DELAY_MS) / ENTER_MS));
        const bob = Math.sin((t / 3200) * Math.PI * 2) * 0.028;
        const sway = Math.sin((t / 4100) * Math.PI * 2) * 3;
        icon.style.transform = `translateY(${bob}em) rotate(${sway - 14 * (1 - p)}deg) scale(${0.7 + 0.3 * p})`;
      }

      // The panel crossfades over a window that straddles each word change.
      const half = PANEL_FADE_MS / 2;
      let from = i;
      let to = i;
      let w = 0;
      if (s > SLOT_MS - half) {
        to = (i + 1) % n;
        w = smoothstep((s - (SLOT_MS - half)) / PANEL_FADE_MS);
      } else if (s < half && t >= SLOT_MS) {
        from = (i - 1 + n) % n;
        w = smoothstep((s + half) / PANEL_FADE_MS);
      }
      layers.forEach((el, k) => {
        if (!el) return;
        const dx = Math.sin((t / 9000) * Math.PI * 2 + k) * 2.2;
        const dy = Math.cos((t / 11000) * Math.PI * 2 + k) * 1.6;
        el.style.transform = `translate(${dx}%, ${dy}%) scale(1.08)`;
        if (k === from) {
          el.style.opacity = "1";
          el.style.zIndex = "1";
        } else if (k === to) {
          el.style.opacity = String(w);
          el.style.zIndex = "2";
        } else {
          el.style.opacity = "0";
          el.style.zIndex = "0";
        }
      });

      cta?.classList.toggle(
        styles.flash,
        i === FLASH_INDEX && s > ENTER_MS - 100 && s < SLOT_MS - LEAVE_MS + 60,
      );
    };

    let frame = requestAnimationFrame(function tick() {
      render(Number(clock.currentTime ?? 0));
      frame = requestAnimationFrame(tick);
    });

    const onVisibility = () => (document.hidden ? clock.pause() : clock.play());
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibility);
      clock.cancel();
    };
  }, []);

  return (
    <section className={styles.hero}>
      <div ref={clockRef} hidden />

      <div className={styles.panel}>
        <div className={styles.layers} aria-hidden="true">
          {WORDS.map((w, k) => (
            <div
              key={w.word}
              ref={(el) => {
                layerRefs.current[k] = el;
              }}
              className={`${styles.layer} ${w.layer}`}
              style={{ opacity: k === 0 ? 1 : 0 }}
            />
          ))}
          <div className={styles.grain} />
        </div>

        <nav className={styles.nav} aria-label="Main">
          <a href="/" className={styles.brand}>
            <span className={styles.brandDot} aria-hidden="true" />
            muuve
          </a>
          <div className={styles.navLinks}>
            <a href="#how-it-works">How it works</a>
            <a href="#batch">Batch payments</a>
            <a href="#safety">Safety</a>
            <a href="/start" className={styles.navButton}>
              Get started
            </a>
          </div>
        </nav>

        <h1 className={styles.headline}>
          <span className="sr-only">Send money to a person with one link</span>
          <span aria-hidden="true" className={styles.slot}>
            {WORDS.map((w, j) => (
              <span
                key={w.word}
                ref={(el) => {
                  wordRefs.current[j] = el;
                }}
                className={styles.word}
                style={{ opacity: 0 }}
              >
                <span
                  ref={(el) => {
                    iconRefs.current[j] = el;
                  }}
                  className={styles.icon}
                  style={{ "--tint": w.tint, "--mask": `url(${w.icon})` } as CSSProperties}
                >
                  <img src={w.icon} alt="" width={320} height={320} decoding="async" />
                  <span className={styles.tint} />
                </span>
                {w.word}
              </span>
            ))}
          </span>
          <span aria-hidden="true" className={styles.line2}>
            with one link
          </span>
        </h1>
        <noscript>
          <style>{`.${styles.word}:first-child{opacity:1!important}`}</style>
        </noscript>

        <div className={styles.row}>
          <div className={styles.buttons}>
            <a ref={ctaRef} href="/start" className={styles.cta}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
              Get started
            </a>
            <a href="#how-it-works" className={styles.cta}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 5.5v13l10.5-6.5z" />
              </svg>
              See how it works
            </a>
          </div>
          <p className={styles.caption}>
            Muuve turns dollars into a link you share on WhatsApp.
            <br />
            They verify their number, then cash out to naira or keep dollars.
          </p>
        </div>
      </div>

      <div className={styles.strip}>
        <svg
          className={styles.notch}
          viewBox="0 0 1440 62"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d="M0 62 H1062 C1092 62 1098 54 1116 34 C1138 9 1146 1 1178 1 H1440 V62 Z" />
        </svg>
        <a href="#how-it-works" className={styles.scrollHint}>
          ↓ Scroll to see how it works
        </a>

        <div className={styles.stripInner}>
          <p className={styles.stripTitle}>
            No bank details.
            <br />
            Just their number.
          </p>
          <dl className={styles.stats}>
            <div>
              <dt>1 link</dt>
              <dd>Pays up to 10 people</dd>
            </div>
            <div>
              <dt>48h</dt>
              <dd>Then unclaimed money returns</dd>
            </div>
            <div>
              <dt>0 apps</dt>
              <dd>Needed to claim</dd>
            </div>
          </dl>
          <svg className={styles.sprout} viewBox="0 0 120 120" aria-hidden="true">
            <path d="M60 104V58" />
            <path d="M60 74C60 56 46 44 26 44c0 18 14 30 34 30Z" />
            <path d="M60 62c0-20 14-34 36-34 0 20-14 34-36 34Z" />
            <path d="M30 104h60" />
          </svg>
        </div>
      </div>
    </section>
  );
}
