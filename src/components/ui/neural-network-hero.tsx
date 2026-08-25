'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

/**
 * Landing hero.
 *
 * What changed, and why:
 *
 *  - The WebGL background is a dynamic import behind an idle callback. three.js
 *    no longer sits on the critical path, so the headline paints immediately
 *    instead of after ~600KB of shader machinery has downloaded and compiled.
 *
 *  - A CSS gradient is painted underneath at all times. If WebGL is missing,
 *    blocked, or still loading, the section still looks deliberate.
 *
 *  - Motion is opt-out. The entrance animation and the shader both respect
 *    `prefers-reduced-motion`, and the copy is readable with neither.
 *
 *  - GSAP and SplitText are gone. The reveal is a CSS transition on four
 *    elements, which does the same job without a 70KB animation runtime — and
 *    without the old failure mode where text was hidden by JS inside a
 *    `document.fonts.ready` callback and stayed invisible if that never ran.
 */

const ShaderBackground = dynamic(() => import('./shader-background'), {
  ssr: false,
  loading: () => null,
});

interface HeroProps {
  title: string;
  description: string;
  badgeText?: string;
  badgeLabel?: string;
  ctaButtons?: Array<{ text: string; href: string; primary?: boolean }>;
  microDetails?: string[];
}

/** True when the user has asked the OS for less animation. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

export default function Hero({
  title,
  description,
  badgeText = 'Solana payments',
  badgeLabel = 'Live',
  ctaButtons = [],
  microDetails = [],
}: HeroProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [revealed, setRevealed] = useState(false);
  const [showShader, setShowShader] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  // Reveal on the next frame so the transition has a start state to animate
  // from. Content is visible either way — this only adds the fade.
  useEffect(() => {
    const id = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Load the shader only once the browser is idle, and never under reduced
  // motion — a per-pixel animated background is exactly what that setting means.
  useEffect(() => {
    if (reducedMotion) return;
    type IdleWindow = Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const w = window as IdleWindow;

    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(() => setShowShader(true), { timeout: 2500 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = setTimeout(() => setShowShader(true), 900);
    return () => clearTimeout(id);
  }, [reducedMotion]);

  const revealClass = (delay: string) =>
    `transition-all duration-700 ease-out motion-reduce:transition-none ${delay} ${
      revealed ? 'translate-y-0 opacity-100 blur-0' : 'translate-y-3 opacity-0 blur-sm'
    }`;

  return (
    <section
      ref={sectionRef}
      // `w-full`, not `w-screen`: w-screen ignores the scrollbar gutter and
      // pushed a horizontal scrollbar onto every desktop page.
      className="relative flex min-h-[100svh] w-full flex-col justify-center overflow-hidden"
    >
      {/* Always painted, so the section never flashes black. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_30%_20%,#1e1b4b_0%,#000_55%),radial-gradient(ellipse_at_80%_80%,#0c2a4d_0%,transparent_60%)]"
      />
      {showShader && (
        <div
          aria-hidden
          className="absolute inset-0 -z-10 animate-[fade-in_900ms_ease-out_forwards] opacity-0"
        >
          <ShaderBackground />
        </div>
      )}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-t from-black/50 via-transparent to-black/25"
      />

      <div className="mx-auto flex w-full max-w-7xl flex-col items-start gap-6 px-6 py-24 sm:gap-8 md:px-10 lg:px-16">
        <div
          className={`inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 backdrop-blur-sm ${revealClass('delay-0')}`}
        >
          <span className="text-[10px] font-light uppercase tracking-[0.08em] text-white/70">
            {badgeLabel}
          </span>
          <span aria-hidden className="h-1 w-1 rounded-full bg-white/40" />
          <span className="text-xs font-light tracking-tight text-white/80">{badgeText}</span>
        </div>

        <h1
          className={`max-w-3xl text-balance text-4xl font-extralight leading-[1.08] tracking-tight text-white sm:text-6xl md:text-7xl ${revealClass('delay-75')}`}
        >
          {title}
        </h1>

        <p
          className={`max-w-xl text-pretty text-base font-light leading-relaxed tracking-tight text-white/75 sm:text-lg ${revealClass('delay-150')}`}
        >
          {description}
        </p>

        {ctaButtons.length > 0 && (
          <div className={`flex flex-wrap items-center gap-3 pt-2 ${revealClass('delay-200')}`}>
            {ctaButtons.map((button) => (
              <a
                key={button.href}
                href={button.href}
                className={`rounded-2xl border border-white/10 px-5 py-3 text-sm font-light tracking-tight transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
                  button.primary
                    ? 'bg-white/10 text-white backdrop-blur-sm hover:bg-white/20'
                    : 'text-white/80 hover:bg-white/5'
                }`}
              >
                {button.text}
              </a>
            ))}
          </div>
        )}

        {microDetails.length > 0 && (
          <ul
            className={`mt-6 flex flex-wrap gap-x-6 gap-y-2 text-xs font-extralight tracking-tight text-white/60 ${revealClass('delay-300')}`}
          >
            {microDetails.map((detail) => (
              <li key={detail} className="flex items-center gap-2">
                <span aria-hidden className="h-1 w-1 rounded-full bg-white/40" /> {detail}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
