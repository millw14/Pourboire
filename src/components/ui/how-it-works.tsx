'use client';

import { Reveal } from './reveal';
import { exampleCommand, BOT_HANDLE } from '@/lib/tip-command';

/**
 * The three-step explainer.
 *
 * The command shown here comes from `src/lib/tip-command.ts`, the same module the
 * poller parses with. The previous copy taught `@Pourboire tip 0.5 SOL`, which
 * the parser could not match on two counts — wrong handle, and it required an
 * explicit `@recipient`. Anyone who followed the instructions got silence.
 */

const STEPS = [
  {
    number: '01',
    title: 'Find a post worth tipping',
    body: 'Anything on X. The person does not need a Pourboire account, or any wallet at all.',
  },
  {
    number: '02',
    title: 'Reply with the command',
    body: `Mention ${BOT_HANDLE} with an amount. The tip goes to whoever wrote the post you replied to.`,
    code: exampleCommand(0.5),
  },
  {
    number: '03',
    title: 'It lands in seconds',
    body: 'We reply with the transaction. If they have not signed up yet, we hold the tip in a wallet that becomes theirs when they do.',
  },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" className="relative w-full bg-black py-20 sm:py-28">
      <div className="mx-auto max-w-5xl px-6">
        <Reveal as="h2" className="text-3xl font-extralight tracking-tight text-white sm:text-4xl">
          How it works
        </Reveal>

        <ol className="mt-12 grid gap-8 sm:grid-cols-3 sm:gap-6">
          {STEPS.map((step, i) => (
            <Reveal as="li" key={step.number} index={i + 1} className="min-w-0">
              <span
                aria-hidden
                className="font-mono text-xs font-light tracking-[0.2em] text-white/30"
              >
                {step.number}
              </span>
              <h3 className="mt-3 text-lg font-light tracking-tight text-white">{step.title}</h3>
              <p className="mt-2 text-sm font-light leading-relaxed text-white/60">{step.body}</p>
              {'code' in step && step.code && (
                <code className="mt-3 block break-words rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs text-blue-200">
                  {step.code}
                </code>
              )}
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}

export default HowItWorks;
