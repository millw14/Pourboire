import 'server-only';
import { isSupportedCurrency, type Rate } from './currencies';

/**
 * Fetching indicative USD → local currency rates.
 *
 * These exist so someone can see "50 USDG ≈ ₦66,942" instead of doing the
 * arithmetic in their head. They are **not** the rate anyone gets paid at.
 *
 * That distinction matters more than it sounds. In several of the markets this
 * feature is for, the official rate and the rate you can actually transact at
 * differ by a wide margin, and a provider's quote adds spread and fees on top.
 * Presenting this number as the payout would systematically overstate what
 * people receive — so it is labelled indicative everywhere it surfaces, and the
 * binding figure always comes from the payout provider at quote time.
 *
 * Currency data and formatting live in `./currencies`, which has no I/O and is
 * safe to import from the browser.
 */

export type { Rate } from './currencies';

interface RateCache {
  rates: Record<string, number>;
  asOf: string;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;

let cache: RateCache | null = null;
let inFlight: Promise<RateCache | null> | null = null;

async function load(): Promise<RateCache> {
  const res = await fetch('https://open.er-api.com/v6/latest/USD', {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`rate source returned ${res.status}`);

  const body = (await res.json()) as {
    result?: string;
    rates?: Record<string, number>;
    time_last_update_utc?: string;
  };
  if (body.result !== 'success' || !body.rates) {
    throw new Error('rate source returned no rates');
  }

  return {
    rates: body.rates,
    asOf: body.time_last_update_utc ?? new Date().toUTCString(),
    fetchedAt: Date.now(),
  };
}

/**
 * Current indicative rate, or null if the source is unreachable.
 *
 * Returns null rather than throwing or guessing. "Rate unavailable" is honest,
 * and a stale-but-labelled number is acceptable; an invented one is not.
 */
export async function getRate(currency: string): Promise<Rate | null> {
  const code = currency.toUpperCase();
  if (!isSupportedCurrency(code)) return null;

  const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (!fresh) {
    // Single-flight: a burst of dashboard loads should cause one upstream call,
    // not one per request.
    inFlight ??= load()
      .then((loaded) => {
        cache = loaded;
        return loaded;
      })
      // Keep the stale value rather than dropping to null — an hour-old rate
      // labelled with its date beats no number at all.
      .catch(() => cache)
      .finally(() => {
        inFlight = null;
      });
    await inFlight;
  }

  const perUsd = cache?.rates[code];
  if (!cache || typeof perUsd !== 'number') return null;

  return { currency: code, perUsd, asOf: cache.asOf };
}
