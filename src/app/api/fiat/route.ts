import { NextRequest } from 'next/server';
import connectDB from '@/lib/mongodb';
import { requireCaller } from '@/lib/auth';
import { handleError, ok, rateLimit, tooManyRequests } from '@/lib/api';
import { resolveCallerUser } from '@/lib/wallets';
import { cardAvailability, cardProvider, liveCapabilities, payoutAvailability } from '@/lib/fiat/registry';
import { getRate } from '@/lib/fiat/rates';
import { corridorKey, METHOD_LABELS } from '@/lib/fiat/corridors';
import { summariseVerification } from '@/lib/fiat/subject';
import {
  SUPPORTED_CURRENCIES,
  currencyMeta,
  formatLocal,
  isSupportedCurrency,
} from '@/lib/fiat/currencies';

/**
 * Everything the dashboard needs to render the cash-out and card sections.
 *
 * Two separate questions, deliberately answered separately:
 *
 *  - What is this balance worth in local money? Answerable today, from public
 *    FX data, and useful on its own. Labelled indicative.
 *  - Can this person actually cash out or get a card? Answerable only when a
 *    licensed provider is contracted. Until then this reports `available: false`
 *    with a reason, and the UI says so plainly rather than showing a button that
 *    cannot work.
 *
 * `payout.corridors` replaces the old `payout.currencies`. A currency was never
 * enough to describe a payout: Nigeria by bank and Nigeria by mobile money are
 * separate claims, each of which has to be exercised against a live API before
 * it can be advertised.
 */

export const maxDuration = 20;

export async function GET(req: NextRequest) {
  try {
    const caller = await requireCaller(req);
    if (!rateLimit(`fiat:${caller.privyUserId}`, 60, 60_000)) return tooManyRequests();

    await connectDB();
    const user = await resolveCallerUser(caller);

    const requested = req.nextUrl.searchParams.get('currency');
    const currency =
      requested && isSupportedCurrency(requested)
        ? requested.toUpperCase()
        : (user?.preferredCurrency ?? 'USD');

    const rate = await getRate(currency);
    const payout = payoutAvailability();
    const card = cardAvailability();

    return ok({
      // Indicative FX. Present regardless of whether payouts are live, because
      // knowing what a tip is worth locally is useful on its own.
      rate: rate
        ? {
            currency: rate.currency,
            perUsd: rate.perUsd,
            asOf: rate.asOf,
            symbol: currencyMeta(rate.currency)?.symbol ?? '',
            // Named so no caller can mistake this for a payout figure.
            indicative: true,
          }
        : null,

      currencies: SUPPORTED_CURRENCIES.map((c) => ({ ...c })),
      preferredCurrency: currency,

      payout: {
        ...payout,
        // Empty until a corridor has actually been paid on. Listing one we have
        // only read about in a coverage map is the same class of lie as a
        // disabled button that looks enabled.
        corridors: liveCapabilities().map((c) => ({
          key: corridorKey(c.corridor),
          country: c.corridor.country,
          currency: c.corridor.currency,
          method: c.corridor.method,
          methodLabel: METHOD_LABELS[c.corridor.method],
          minMinor: c.limits.minMinor,
          maxMinor: c.limits.maxMinor,
          requires: c.requires,
          // A range, never a promise.
          etaHours: c.etaHours,
        })),
      },

      card: {
        ...card,
        brand: cardProvider()?.brand ?? null,
        // Card state is only ever a reference plus a status; the app never holds
        // a card number.
        current: user?.card
          ? {
              status: user.card.status,
              last4: user.card.last4,
              brand: user.card.brand,
            }
          : null,
      },

      verification: {
        // Per-provider records are the truth; the legacy single field is the
        // fallback for documents written before they existed.
        status: user?.verifications?.length
          ? summariseVerification(user.verifications)
          : (user?.verification?.status ?? 'unstarted'),
        reason: user?.verification?.reason,
        payoutCountry: user?.payoutCountry ?? null,
        // Why this exists at all, in the response, so the UI never has to invent
        // an explanation for asking.
        requiredFor: ['payout', 'card'],
      },
    });
  } catch (e) {
    return handleError('fiat', e);
  }
}

/**
 * Convert a USD amount to the indicative local equivalent.
 *
 * Explicitly not a quote. When a provider is live, a binding quote comes from
 * `PayoutProvider.quote`, carries an id and an expiry, and is what the payout is
 * executed against.
 */
export async function POST(req: NextRequest) {
  try {
    const caller = await requireCaller(req);
    if (!rateLimit(`fiat-convert:${caller.privyUserId}`, 60, 60_000)) return tooManyRequests();

    const body = await req.json().catch(() => ({}));
    const currency = String(body.currency ?? 'USD');
    const usd = Number(body.usd);

    if (!Number.isFinite(usd) || usd < 0) {
      return ok({ indicative: null, reason: 'Enter a valid amount' });
    }
    if (!isSupportedCurrency(currency)) {
      return ok({ indicative: null, reason: 'That currency is not supported yet' });
    }

    const rate = await getRate(currency);
    if (!rate) {
      return ok({ indicative: null, reason: 'Exchange rates are unavailable right now' });
    }

    return ok({
      indicative: {
        currency: rate.currency,
        formatted: formatLocal(usd, rate),
        perUsd: rate.perUsd,
        asOf: rate.asOf,
      },
      // Repeated at the point of use, because this is where someone is most
      // likely to read a number and assume it is what they will receive.
      disclaimer:
        'Indicative only, at the official rate. The amount you actually receive depends on the payout partner and will be quoted before you confirm.',
    });
  } catch (e) {
    return handleError('fiat/convert', e);
  }
}
