'use client';

import { useEffect, useState } from 'react';
import { useApi, ApiError } from '@/lib/use-api';
import { formatLocal } from '@/lib/fiat/currencies';
import type { FiatResponse } from './types';

/**
 * Local currency, cashing out, and the card.
 *
 * Three things at different stages of readiness, shown honestly rather than
 * uniformly:
 *
 *  - The local-currency value works today, from public FX data, and is labelled
 *    indicative because the official rate is not what a payout partner pays.
 *  - Cashing out and the card need a licensed provider under contract. Until
 *    one is, this says so in words instead of showing a button that cannot work.
 *
 * Building the disabled state properly matters more than it looks: a "Get your
 * card" button that silently does nothing is exactly the pattern this whole
 * dashboard was rewritten to remove.
 */

interface Props {
  /** Total USD value of the wallet's stable holdings, for the conversion. */
  usdValue: number;
}

export function CashOutCard({ usdValue }: Props) {
  const api = useApi();
  const [data, setData] = useState<FiatResponse | null>(null);
  // The selected currency is the input, not something read back out of the
  // response — deriving it from the fetch and then re-fetching on it would loop.
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const res = await api<FiatResponse>(`/api/fiat?currency=${encodeURIComponent(currency)}`);
        if (cancelled) return;
        setData(res);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : 'Could not load currency information.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, currency]);

  if (error) {
    return (
      <section className="rounded-xl border border-white/10 bg-white/5 p-5">
        <p role="alert" className="text-sm font-light text-white/60">
          {error}
        </p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="h-40 animate-pulse rounded-xl bg-white/5 motion-reduce:animate-none" />
    );
  }

  const local =
    data.rate && data.rate.currency !== 'USD'
      ? formatLocal(usdValue, data.rate)
      : null;

  return (
    <section className="space-y-6 rounded-xl border border-white/10 bg-white/5 p-5 backdrop-blur-sm">
      {/* ---------------------------------------------------- local value */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-light tracking-tight">Value in local currency</h2>
          <label className="flex items-center gap-2">
            <span className="sr-only">Currency</span>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs outline-none transition focus:border-white/30 focus-visible:ring-2 focus-visible:ring-white/40"
            >
              {data.currencies.map((c) => (
                <option key={c.code} value={c.code} className="bg-neutral-900">
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {local ? (
          <>
            <p className="mt-3 text-3xl font-extralight tracking-tight tabular-nums">{local}</p>
            <p className="mt-1.5 text-xs font-light leading-relaxed text-white/40">
              Indicative, at the official rate as of {shortDate(data.rate!.asOf)}. What you
              actually receive depends on the payout partner and is quoted before you confirm.
            </p>
          </>
        ) : data.rate ? (
          <p className="mt-3 text-3xl font-extralight tracking-tight tabular-nums">
            ${usdValue.toFixed(2)}
          </p>
        ) : (
          <p className="mt-3 text-sm font-light text-white/50">
            Exchange rates are unavailable right now.
          </p>
        )}
      </div>

      {/* --------------------------------------------------------- cash out */}
      <Feature
        title="Cash out to a bank account"
        available={data.payout.available}
        reason={data.payout.reason}
        action="Cash out"
      />

      {/* ------------------------------------------------------------- card */}
      <Feature
        title="Dollar card"
        available={data.card.available}
        reason={data.card.reason}
        action="Get a card"
        detail={
          data.card.current
            ? `${data.card.current.brand ?? 'Card'} •••• ${data.card.current.last4 ?? '····'} — ${data.card.current.status}`
            : 'Spend your balance anywhere cards are accepted, including bills.'
        }
      />

      {data.verification.status !== 'verified' && (data.payout.available || data.card.available) && (
        <p className="rounded-lg bg-white/5 px-3 py-2 text-xs font-light leading-relaxed text-white/50">
          Both need identity verification first — receiving tips never does, but paying money
          out to a bank or a card is regulated and the partner has to know who you are.
        </p>
      )}
    </section>
  );
}

function Feature({
  title,
  available,
  reason,
  action,
  detail,
}: {
  title: string;
  available: boolean;
  reason?: string;
  action: string;
  detail?: string;
}) {
  return (
    <div className="border-t border-white/10 pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-light tracking-tight">{title}</h3>
          {detail && (
            <p className="mt-1 text-xs font-light leading-relaxed text-white/50">{detail}</p>
          )}
          {!available && reason && (
            <p className="mt-1.5 text-xs font-light leading-relaxed text-amber-300/80">{reason}</p>
          )}
        </div>
        <button
          type="button"
          disabled={!available}
          // No onClick while unavailable: a disabled control that still fires is
          // how the previous dashboard ended up with buttons that did nothing.
          className="shrink-0 rounded-xl bg-[#00C805] px-4 py-2 text-sm font-medium text-black transition hover:bg-[#00B004] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40"
        >
          {available ? action : 'Not yet'}
        </button>
      </div>
    </div>
  );
}

function shortDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? 'today'
    : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d);
}
