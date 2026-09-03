import { NextRequest } from 'next/server';
import connectDB from '@/lib/mongodb';
import { requireCaller } from '@/lib/auth';
import { check, fail, handleError, ok, rateLimit, tooManyRequests } from '@/lib/api';
import { resolveCallerUser } from '@/lib/wallets';
import Payout from '@/models/Payout';
import PayoutDestination from '@/models/PayoutDestination';
import { resolvePayoutContext } from '@/lib/fiat/context';
import { corridorKey } from '@/lib/fiat/corridors';
import { ProviderError } from '@/lib/fiat/types';
import { isNeverSettlement } from '@/lib/fiat/settlement-token';
import { parseTokenAmount, resolveToken } from '@/lib/settle';

/**
 * A binding quote, and the payout row that will execute against it.
 *
 * The indicative rates on the dashboard are public FX data and are labelled as
 * such. This is the other thing entirely: a number from the provider, inclusive
 * of their spread, with an expiry, which is what the user is actually held to.
 *
 * Creating the row here rather than at confirm time is what makes the rest safe.
 * The partial unique index on `{userId, active}` means a second quote while one
 * is open is refused by the database rather than by a check someone can forget,
 * and it makes the idempotency key derivable — `${provider}:${quoteId}` — rather
 * than something a client supplies.
 */

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const caller = await requireCaller(req);
    if (!rateLimit(`fiat-quote:${caller.privyUserId}`, 10, 60_000)) return tooManyRequests();

    await connectDB();
    const user = await resolveCallerUser(caller);
    check(user, 'No tip wallet found for your account');

    const body = await req.json().catch(() => ({}));
    const destinationId = String(body.destinationId ?? '');
    check(destinationId, 'Choose where the money should go');

    const destination = await PayoutDestination.findOne({
      _id: destinationId,
      userId: user._id,
      archivedAt: { $exists: false },
    });
    check(destination, 'We could not find that account');

    let token;
    try {
      token = await resolveToken(String(body.token ?? 'USDG'));
    } catch {
      return fail(400, "I don't recognise that token", 'unknown_token');
    }

    // The token to spend arrives in the request body, so without this a client
    // could point "cash out" at an equity. The corridor's rail is not known
    // until routing, so this catches only the categories that are wrong whatever
    // the destination — the byte-exact check runs again at the funding step.
    if (isNeverSettlement(token.info.kind)) {
      return fail(
        400,
        token.info.kind === 'equity'
          ? `We will not sell your ${token.info.symbol} to cash out. Swap it yourself first if that is what you want.`
          : `${token.info.symbol} cannot be cashed out.`,
        'not_settlement_token'
      );
    }

    const parsed = parseTokenAmount(String(body.amount ?? ''), token);
    if (!parsed.ok) return fail(400, parsed.message, 'invalid_amount');

    // The corridor comes from the stored destination, never from the request.
    // A client cannot ask for one beneficiary to be paid on another corridor.
    const context = resolvePayoutContext({
      user,
      corridorKey: destination.corridorKey,
      amountMinor: null,
    });
    if (!context.ok) return fail(context.status, context.message, context.code);

    let quote;
    try {
      quote = await context.provider.quote({
        subject: context.subject,
        corridor: context.corridor,
        sourceAmount: parsed.base.toString(),
        sourceToken: token.info.symbol,
      });
    } catch (e) {
      const message = e instanceof ProviderError ? e.refusal.message : 'We could not get a quote.';
      return fail(502, message, 'quote_failed');
    }

    // Now the amount is known in the destination currency, so the corridor's
    // limits can be applied to the figure they are actually about.
    const limits = resolvePayoutContext({
      user,
      corridorKey: destination.corridorKey,
      amountMinor: BigInt(quote.destinationAmount),
    });
    if (!limits.ok) return fail(limits.status, limits.message, limits.code);

    try {
      const payout = await Payout.create({
        userId: user._id,
        status: 'quoted',
        active: true,
        provider: context.provider.name,
        corridorKey: corridorKey(context.corridor),
        idemKey: `${context.provider.name}:${quote.id}`,
        quoteId: quote.id,
        quoteExpiresAt: quote.expiresAt,
        sourceAmount: quote.sourceAmount,
        sourceToken: quote.sourceToken,
        quotedDestinationMinor: quote.destinationAmount,
        feeMinor: quote.fee,
        destinationRef: destination.recipientRef,
      });

      return ok({
        payoutId: String(payout._id),
        quote: {
          sourceAmount: quote.sourceAmount,
          sourceToken: quote.sourceToken,
          destinationAmount: quote.destinationAmount,
          currency: context.corridor.currency,
          rate: quote.rate,
          fee: quote.fee,
          expiresAt: quote.expiresAt,
        },
        // Said plainly, because it is the number they will be held to and the
        // dashboard has been showing indicative figures up to this point.
        binding: true,
      });
    } catch (e) {
      // The partial unique index refusing a second open payout. Not an error
      // condition so much as the answer to "can I start another one?".
      if ((e as { code?: number })?.code === 11000) {
        return fail(409, 'You already have a payout in progress.', 'payout_in_progress');
      }
      throw e;
    }
  } catch (e) {
    return handleError('fiat/quote', e);
  }
}
