'use client';

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { useApi, ApiError } from '@/lib/use-api';
import { KNOWN_TOKENS, isNative } from '@/lib/tokens';
import type { Balance } from './types';

/**
 * Turn one holding into another.
 *
 * The only spend path that works today without a licensed partner, so it is
 * worth doing properly: quote before committing, show the guaranteed floor
 * rather than only the estimate, and never let the button fire while the quote
 * is stale.
 */

interface SwapQuote {
  from: string;
  to: string;
  amountIn: string;
  estimatedOut: string;
  minimumOut: string;
  slippageBps: number;
  feePips: number;
  poolShareBps: number;
}

interface QuoteResponse {
  success: true;
  quote: SwapQuote;
}

interface SwapResponse {
  success: true;
  status: 'confirmed' | 'unconfirmed' | 'pending_approval';
  txHash: string;
  explorerUrl: string;
  message?: string;
}

/** ETH is excluded: it pays gas, and swapping it would need wrapping first. */
const SWAPPABLE = KNOWN_TOKENS.filter((t) => !isNative(t));

interface Props {
  onClose: () => void;
  balances: Balance[];
  onSwapped: () => void;
}

export function SwapDialog({ onClose, balances, onSwapped }: Props) {
  const api = useApi();
  const { toast } = useToast();

  const sellable = balances.filter((b) => !b.isGas && BigInt(b.raw) > 0n);
  const [from, setFrom] = useState(sellable[0]?.symbol ?? 'USDG');
  const [to, setTo] = useState(() => (sellable[0]?.symbol === 'NVDA' ? 'USDG' : 'NVDA'));
  const [amount, setAmount] = useState('');
  // The quote is stored with the exact inputs that produced it, so staleness is
  // an equality check rather than a guess. Matching on the formatted amount by
  // prefix looked fine and was wrong: "100 USDG" starts with "10", so typing a
  // shorter amount would have shown the previous, larger quote.
  const [quote, setQuote] = useState<{ for: string; value: SwapQuote } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const held = sellable.find((b) => b.symbol === from) ?? null;

  const amountError = useMemo(() => {
    if (!amount.trim()) return null;
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return 'Enter a valid amount';
    return null;
  }, [amount]);

  // Quote as the inputs settle. Debounced, because every keystroke would
  // otherwise be an RPC round trip against the pool.
  // Whether the inputs are even worth pricing. Derived rather than branched on
  // inside the effect, so the effect never sets state synchronously.
  const quotable = Boolean(amount.trim()) && !amountError && from !== to;
  /** Identifies the exact inputs a quote was fetched for. */
  const quoteKey = `${from}>${to}:${amount.trim()}`;

  useEffect(() => {
    if (!quotable) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setQuoting(true);
        try {
          const res = await api<QuoteResponse>('/api/swap', {
            method: 'POST',
            body: JSON.stringify({ from, to, amount, preview: true }),
          });
          if (cancelled) return;
          setQuote({ for: quoteKey, value: res.quote });
          setQuoteError(null);
        } catch (e) {
          if (cancelled) return;
          setQuote(null);
          setQuoteError(e instanceof ApiError ? e.message : 'Could not price that swap.');
        } finally {
          if (!cancelled) setQuoting(false);
        }
      })();
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, from, to, amount, quotable, quoteKey]);

  // A quote belongs to the inputs that produced it. Rather than clearing it from
  // an effect, it is simply not shown once those inputs change — which also
  // closes the window where a stale price could be submitted.
  const liveQuote = quotable && quote?.for === quoteKey ? quote.value : null;

  const submit = async () => {
    if (!liveQuote || submitting) return;
    setSubmitting(true);
    try {
      const res = await api<SwapResponse>('/api/swap', {
        method: 'POST',
        body: JSON.stringify({ from, to, amount }),
      });

      if (res.status === 'pending_approval') {
        toast({
          tone: 'pending',
          title: 'Approval still confirming',
          description: res.message,
          action: { label: 'View on explorer', href: res.explorerUrl },
        });
      } else if (res.status === 'unconfirmed') {
        toast({
          tone: 'pending',
          title: 'Swap sent, not confirmed yet',
          description: res.message,
          action: { label: 'View on explorer', href: res.explorerUrl },
        });
      } else {
        toast({
          tone: 'success',
          title: `Swapped ${liveQuote.amountIn} for ${to}`,
          description: `At least ${liveQuote.minimumOut} was guaranteed.`,
          action: { label: 'View on explorer', href: res.explorerUrl },
        });
      }

      onSwapped();
      onClose();
    } catch (e) {
      toast({
        tone: 'error',
        title: 'Swap failed',
        description: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = Boolean(liveQuote) && !quoting && !submitting;

  return (
    <Modal
      open
      onClose={onClose}
      busy={submitting}
      title="Swap"
      description="Turn one holding into another, on-chain."
    >
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-sm font-light text-white/70">From</span>
            {held && (
              <button
                type="button"
                onClick={() => setAmount(held.amount.split(' ')[0]?.replace(/,/g, '') ?? '')}
                disabled={submitting}
                className="rounded text-xs font-light text-blue-300 hover:text-blue-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                Max — {held.amount}
              </button>
            )}
          </span>
          <div className="flex gap-2">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={submitting}
              inputMode="decimal"
              placeholder="100"
              aria-invalid={Boolean(amountError)}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-base tabular-nums outline-none transition focus:border-white/30 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
            />
            <select
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              disabled={submitting || sellable.length === 0}
              aria-label="Token to swap from"
              className="rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm outline-none transition focus:border-white/30 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
            >
              {sellable.length === 0 ? (
                <option className="bg-neutral-900">Nothing to swap</option>
              ) : (
                sellable.map((b) => (
                  <option key={b.symbol} value={b.symbol} className="bg-neutral-900">
                    {b.symbol}
                  </option>
                ))
              )}
            </select>
          </div>
          {amountError && (
            <span role="alert" className="mt-1.5 block text-xs font-light text-red-300">
              {amountError}
            </span>
          )}
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-light text-white/70">To</span>
          <select
            value={to}
            onChange={(e) => setTo(e.target.value)}
            disabled={submitting}
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm outline-none transition focus:border-white/30 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
          >
            {SWAPPABLE.filter((t) => t.symbol !== from).map((t) => (
              <option key={t.symbol} value={t.symbol} className="bg-neutral-900">
                {t.symbol} — {t.name}
              </option>
            ))}
          </select>
        </label>

        <div className="min-h-[76px] rounded-lg bg-white/5 px-3 py-2.5">
          {quoting ? (
            <p className="text-sm font-light text-white/50">Pricing…</p>
          ) : quoteError ? (
            <p role="alert" className="text-sm font-light text-amber-300">
              {quoteError}
            </p>
          ) : liveQuote ? (
            <dl className="space-y-1 text-xs font-light">
              <div className="flex justify-between gap-3">
                <dt className="text-white/50">You get about</dt>
                <dd className="tabular-nums text-white">{liveQuote.estimatedOut}</dd>
              </div>
              <div className="flex justify-between gap-3">
                {/* The binding number. The estimate above can move; this cannot. */}
                <dt className="text-white/50">Guaranteed at least</dt>
                <dd className="tabular-nums text-white/80">{liveQuote.minimumOut}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-white/50">Pool fee</dt>
                <dd className="tabular-nums text-white/50">
                  {(liveQuote.feePips / 10_000).toFixed(2)}% · slippage{' '}
                  {(liveQuote.slippageBps / 100).toFixed(2)}%
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm font-light text-white/40">Enter an amount to see a price.</p>
          )}
        </div>

        <p className="rounded-lg bg-white/5 px-3 py-2 text-xs font-light leading-relaxed text-white/50">
          Prices move. You are guaranteed the minimum shown — if the price falls
          past it before the trade lands, the swap reverts and nothing is spent
          but gas.
        </p>

        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="flex-1 rounded-lg bg-white/10 px-4 py-2.5 text-sm font-light transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="flex-1 rounded-lg bg-[#00C805] px-4 py-2.5 text-sm font-medium text-black transition hover:bg-[#00B004] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Swapping…' : 'Swap'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
