'use client';

import { useEffect, useRef, useState } from 'react';
import { Reveal } from './reveal';
import { exampleCommand } from '@/lib/tip-command';

/**
 * A phone mock that plays through what sending a tip looks like.
 *
 * Replaces `simple-phone-tutorial.tsx` (528 lines) and the five near-identical
 * variants beside it that nothing imported. Notable fixes:
 *
 *  - It actually plays. The old component defined a `startTutorial` function
 *    that was never called from anywhere, so the phone sat on step one forever.
 *  - It is reachable by keyboard, and pausable.
 *  - It stops when scrolled off screen instead of running its timers forever.
 *  - Under `prefers-reduced-motion` it shows the final state, no animation.
 */

const STEPS = [
  {
    label: 'The post',
    body: 'gm. shipped the thing.',
    author: '@builder',
    sent: false,
  },
  {
    label: 'Your reply',
    body: exampleCommand(0.5),
    author: '@you',
    sent: false,
  },
  {
    label: 'Confirmation',
    body: '@builder @you sent you 0.5 SOL. It is already in your tip wallet.',
    author: '@Pourboireonsol',
    sent: true,
  },
] as const;

const STEP_MS = 2600;

export function TipDemo() {
  const [rawStep, setRawStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const hostRef = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const q = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(q.matches);
    update();
    q.addEventListener('change', update);
    return () => q.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const node = hostRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setOnScreen(true);
      return;
    }
    const observer = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting), {
      threshold: 0.35,
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || !onScreen || reducedMotion) return;
    const id = setInterval(() => setRawStep((s) => (s + 1) % STEPS.length), STEP_MS);
    return () => clearInterval(id);
  }, [playing, onScreen, reducedMotion]);

  // Reduced motion gets the end state directly — the point of the demo is the
  // outcome, not the transition. Derived rather than pushed into state, so there
  // is no render where the wrong step is showing.
  const step = reducedMotion ? STEPS.length - 1 : rawStep;

  return (
    <section id="tutorial" className="relative w-full bg-black py-20 sm:py-28">
      <div className="mx-auto grid max-w-5xl items-center gap-12 px-6 md:grid-cols-2 md:gap-16">
        <div className="min-w-0">
          <Reveal as="h2" className="text-3xl font-extralight tracking-tight text-white sm:text-4xl">
            One reply. That&apos;s the whole thing.
          </Reveal>
          <Reveal
            index={1}
            as="p"
            className="mt-4 max-w-md text-base font-light leading-relaxed text-white/70"
          >
            No app to install, no address to ask for, no wallet needed on their side. Reply to a
            post with an amount and the tip is on its way.
          </Reveal>

          <Reveal index={2} as="ol" className="mt-8 space-y-2">
            {STEPS.map((s, i) => (
              <li key={s.label}>
                <button
                  type="button"
                  onClick={() => {
                    setRawStep(i);
                    setPlaying(false);
                  }}
                  aria-current={i === step ? 'step' : undefined}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-light transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
                    i === step ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5'
                  }`}
                >
                  <span
                    aria-hidden
                    className={`h-1.5 w-1.5 shrink-0 rounded-full transition ${
                      i === step ? 'bg-blue-400' : 'bg-white/25'
                    }`}
                  />
                  {s.label}
                </button>
              </li>
            ))}
          </Reveal>

          {!reducedMotion && (
            <Reveal index={3}>
              <button
                type="button"
                onClick={() => setPlaying((p) => !p)}
                className="mt-4 rounded-lg px-3 py-2 text-xs font-light text-white/40 transition hover:text-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                {playing ? 'Pause' : 'Play'} walkthrough
              </button>
            </Reveal>
          )}
        </div>

        <Reveal index={1} className="flex justify-center md:justify-end">
          <div
            ref={hostRef}
            className="w-full max-w-[280px] rounded-[2.25rem] border border-white/15 bg-neutral-950 p-3 shadow-2xl"
          >
            <div className="relative overflow-hidden rounded-[1.75rem] bg-black">
              <div aria-hidden className="mx-auto mt-2 h-1 w-16 rounded-full bg-white/20" />
              <div className="flex min-h-[320px] flex-col justify-end gap-3 p-4">
                {STEPS.slice(0, step + 1).map((s) => (
                  <div
                    key={s.label}
                    className={`animate-[fade-in_320ms_ease-out] rounded-2xl px-3 py-2.5 text-[13px] leading-snug ${
                      s.sent
                        ? 'bg-emerald-500/15 text-emerald-100'
                        : s.author === '@you'
                          ? 'ml-6 bg-blue-500/20 text-blue-50'
                          : 'mr-6 bg-white/10 text-white/80'
                    }`}
                  >
                    <p className="mb-1 text-[10px] font-light uppercase tracking-wide text-white/40">
                      {s.author}
                    </p>
                    <p className="break-words font-light">{s.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
          {/* The visual is decorative; the ordered list beside it carries the
              same content for anyone not seeing this. */}
          <span className="sr-only">
            Example: replying {exampleCommand(0.5)} to a post sends the author half a SOL.
          </span>
        </Reveal>
      </div>
    </section>
  );
}

export default TipDemo;
