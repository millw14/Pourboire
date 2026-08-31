import { NextRequest } from 'next/server';
import connectDB from '@/lib/mongodb';
import { requireCaller } from '@/lib/auth';
import { handleError, ok, rateLimit, tooManyRequests } from '@/lib/api';
import { resolveCallerUser } from '@/lib/wallets';
import { activeProvider, fiatEnabled } from '@/lib/fiat/provider';
import { getRate } from '@/lib/fiat/rates';
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
    const provider = activeProvider();

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
        available: fiatEnabled(),
        // A real reason, not a shrug. This is the state of the product, and
        // saying so is better than an unexplained disabled button.
        reason: fiatEnabled()
          ? undefined
          : 'Cashing out to a bank account needs a licensed payout partner. We are working on it.',
        currencies: provider?.payoutCurrencies ?? [],
      },

      card: {
        available: fiatEnabled() && Boolean(provider?.supportsCards),
        reason:
          fiatEnabled() && provider?.supportsCards
            ? undefined
            : 'Cards need a licensed issuer. We are working on it.',
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
        status: user?.verification?.status ?? 'unstarted',
        reason: user?.verification?.reason,
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
 * `provider.quotePayout`, carries an id and an expiry, and is what the payout
 * is executed against.
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
