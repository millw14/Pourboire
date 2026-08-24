'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { useApi, ApiError } from '@/lib/use-api';
import { KNOWN_TOKENS } from '@/lib/tokens';

/**
 * Convert between tokens inside the tip wallet.
 *
 * The quote is fetched separately from the swap and handed back unmodified, so
 * the price shown on screen is the price executed. Re-quoting at execution time
 * would mean the user approves one number and receives another.
 */

interface QuoteResponse {
  success: true;
  quote: { raw: unknown; slippageBps: number };
  display: {
    pay: string;
    receive: string;
    minimumReceived: string;
    priceImpactPct: string;
  };
}

interface SwapResponse {
  success: true;
  status: 'confirmed' | 'unconfirmed';
  txHash: string;
  explorerUrl: string;
  message?: string;
}

interface SwapDialogProps {
  onClose: () => void;
  onSwapped: () => void;
}

/** Mounted only while open, so its state starts fresh each time. */
export function SwapDialog({ onClose, onSwapped }: SwapDialogProps) {
  const api = useApi();
  const { toast } = useToast();

  const [from, setFrom] = useState('SOL');
  const [to, setTo] = useState('USDC');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  // Guards against a slow quote for an old amount landing after a newer one.
  const requestId = useRef(0);

  const fetchQuote = useCallback(async () => {
    const mine = ++requestId.current;
    const value = Number(amount);

    if (!amount.trim() || !Number.isFinite(value) || value <= 0 || from === to) {
      setQuote(null);
      setQuoteError(null);
      return;
    }

    setQuoting(true);
    setQuoteError(null);
    try {
      const res = await api<QuoteResponse>(
        `/api/wallet/swap?from=${from}&to=${to}&amount=${encodeURIComponent(amount)}`
      );
      if (mine !== requestId.current) return;
      setQuote(res);
    } catch (e) {
      if (mine !== requestId.current) return;
      setQuote(null);
      setQuoteError(e instanceof ApiError ? e.message : 'Could not get a quote.');
    } finally {
      if (mine === requestId.current) setQuoting(false);
    }
  }, [api, amount, from, to]);

  // Debounced: typing an amount should not fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => void fetchQuote(), 400);
    return () => clearTimeout(id);
  }, [fetchQuote]);

  const swap = async () => {
    if (!quote) return;
    setSwapping(true);
    try {
      const res = await api<SwapResponse>('/api/wallet/swap', {
        method: 'POST',
        body: JSON.stringify({ quote: quote.quote }),
      });

      toast({
        tone: res.status === 'unconfirmed' ? 'pending' : 'success',
        title:
          res.status === 'unconfirmed'
            ? 'Swap submitted'
            : `Swapped for ${quote.display.receive}`,
        description: res.message,
        action: { label: 'View on Solscan', href: res.explorerUrl },
      });

      onSwapped();
      onClose();
    } catch (e) {
      toast({
        tone: 'error',
        title: 'Swap failed',
        description: e instanceof ApiError ? e.message : 'Something went wrong.',
      });
    } finally {
      setSwapping(false);
    }
  };

  const impact = quote ? Number(quote.display.priceImpactPct) * 100 : 0;
  const highImpact = impact > 1;

  return (
    <Modal
      onClose={onClose}
      open
      busy={swapping}
      title="Swap"
      description="Convert between tokens inside your tip wallet."
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
          <TokenSelect label="From" value={from} onChange={setFrom} disabled={swapping} />
          <button
            type="button"
            onClick={() => {
              setFrom(to);
              setTo(from);
            }}
            disabled={swapping}
            aria-label="Swap direction"
            className="mb-1 rounded-lg border border-white/10 px-2 py-2 text-white/50 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-40"
          >
            ⇄
          </button>
          <TokenSelect label="To" value={to} onChange={setTo} disabled={swapping} />
        </div>

        <label className="block">
          <span className="mb-1.5 block text-sm font-light text-white/70">Amount</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={swapping}
            inputMode="decimal"
            placeholder="0.5"
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-base tabular-nums outline-none transition focus:border-white/30 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
          />
        </label>

        <div className="min-h-[92px] rounded-lg bg-white/5 p-3 text-sm">
          {quoting ? (
            <p className="font-light text-white/50">Getting the best route…</p>
          ) : quoteError ? (
            <p role="alert" className="font-light text-red-300">
              {quoteError}
            </p>
          ) : quote ? (
            <dl className="space-y-1.5 font-light">
              <Row label="You pay" value={quote.display.pay} />
              <Row label="You receive" value={quote.display.receive} strong />
              <Row label="Minimum received" value={quote.display.minimumReceived} />
              <Row
                label="Price impact"
                value={`${impact.toFixed(2)}%`}
                tone={highImpact ? 'warn' : undefined}
              />
            </dl>
          ) : (
            <p className="font-light text-white/40">Enter an amount to see a quote.</p>
          )}
        </div>

        {highImpact && (
          <p className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 text-xs font-light leading-relaxed text-amber-200">
            This trade moves the price by {impact.toFixed(1)}%. You will get noticeably less than
            the market rate.
          </p>
        )}

        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={swapping}
            className="flex-1 rounded-lg bg-white/10 px-4 py-2.5 text-sm font-light transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void swap()}
            disabled={!quote || swapping || quoting}
            className="flex-1 rounded-lg bg-blue-500 px-4 py-2.5 text-sm font-light transition hover:bg-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {swapping ? 'Swapping…' : 'Swap'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TokenSelect({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-sm font-light text-white/70">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-base outline-none transition focus:border-white/30 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
      >
        {KNOWN_TOKENS.map((t) => (
          <option key={t.symbol} value={t.symbol} className="bg-neutral-900">
            {t.symbol}
          </option>
        ))}
      </select>
    </label>
  );
}

function Row({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: 'warn';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-white/50">{label}</dt>
      <dd
        className={`tabular-nums ${
          tone === 'warn' ? 'text-amber-300' : strong ? 'text-emerald-300' : 'text-white/80'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
