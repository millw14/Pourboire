'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Copy-to-clipboard with feedback the user can actually see.
 *
 * The original set a `copied` state and then never rendered it anywhere, so
 * clicking your wallet address produced no visible change at all — you could not
 * tell whether it had worked.
 */

interface CopyButtonProps {
  value: string;
  /** What to show when idle. Defaults to a middle-truncated version of `value`. */
  label?: string;
  className?: string;
  /** Announced to screen readers, e.g. "tip wallet address". */
  describe?: string;
}

export function truncateMiddle(value: string, lead = 6, tail = 6): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function CopyButton({ value, label, className = '', describe = 'value' }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      // Clipboard access is denied in some embedded and non-secure contexts.
      // Saying so beats pretending it worked.
      setState('failed');
    }
    timer.current = setTimeout(() => setState('idle'), 1800);
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={value}
      aria-label={
        state === 'copied' ? `Copied ${describe}` : `Copy ${describe}: ${value}`
      }
      className={`group inline-flex items-center gap-2 rounded-lg px-2 py-1 font-mono text-sm transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${className}`}
    >
      <span className="truncate">{label ?? truncateMiddle(value, 6, 6)}</span>
      <span
        aria-hidden
        className={`shrink-0 text-xs ${
          state === 'copied'
            ? 'text-emerald-400'
            : state === 'failed'
              ? 'text-red-400'
              : 'text-white/40 group-hover:text-white/70'
        }`}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Press ⌘C' : 'Copy'}
      </span>
    </button>
  );
}
