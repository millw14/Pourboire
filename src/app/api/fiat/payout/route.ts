import { NextRequest } from 'next/server';
import type { Address, Hex } from 'viem';
import connectDB from '@/lib/mongodb';
import { requireCaller } from '@/lib/auth';
import { check, fail, handleError, ok, rateLimit, tooManyRequests } from '@/lib/api';
import { resolveCallerUser } from '@/lib/wallets';
import { decryptPrivateKey } from '@/lib/crypto';
import Payout from '@/models/Payout';
import { resolvePayoutContext } from '@/lib/fiat/context';
import { fundPayout } from '@/lib/fiat/payouts';
import { STATUS_MESSAGES } from '@/lib/fiat/payout-state';
import { findTokenBySymbol } from '@/lib/tokens';

/**
 * Execute a quoted payout: move the stablecoin, then ask the provider to pay.
 *
 * The response shape matters as much as the logic. A payout that ends
 * indeterminate returns **200 with a "do not try again" message**, never a 5xx —
 * a 5xx is what makes clients retry, and a retry is exactly what must not happen
 * when we do not know whether the money moved. `wallet/withdraw` learned this
 * the hard way and the lesson is repeated here on purpose.
 */

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const caller = await requireCaller(req);
    // Deliberately tighter than withdraw's five: a payout is slower, costs a
    // provider call, and nobody legitimately starts three a minute.
    if (!rateLimit(`fiat-payout:${caller.privyUserId}`, 3, 60_000)) return tooManyRequests();

    await connectDB();
    const user = await resolveCallerUser(caller);
    check(user, 'No tip wallet found for your account');
    check(user.encryptedPrivateKey, 'Your tip wallet is not set up yet');

    const body = await req.json().catch(() => ({}));
    const payoutId = String(body.payoutId ?? '');
    check(payoutId, 'Which payout?');

    const payout = await Payout.findOne({ _id: payoutId, userId: user._id });
    check(payout, 'We could not find that payout');

    if (payout.status !== 'quoted') {
      // Includes every frozen and terminal state. Answering with where it stands
      // is more useful than an error, and cannot be read as "try again".
      return ok({
        payoutId: String(payout._id),
        status: payout.status,
        message: STATUS_MESSAGES[payout.status],
        retryable: false,
      });
    }

    if (payout.quoteExpiresAt.getTime() < Date.now()) {
      await Payout.updateOne(
        { _id: payout._id, status: 'quoted' },
        { $set: { status: 'cancelled', note: 'Quote expired' }, $unset: { active: '' } }
      );
      return fail(409, 'That quote expired. Get a new one.', 'quote_expired');
    }

    const context = resolvePayoutContext({
      user,
      corridorKey: payout.corridorKey,
      amountMinor: BigInt(payout.quotedDestinationMinor),
    });
    if (!context.ok) return fail(context.status, context.message, context.code);

    const depositAddress = context.capability.rail.depositAddress;
    if (!depositAddress) {
      // Per-payout deposit addresses are a real pattern; this build has no
      // adapter that mints one, so refusing is honest.
      return fail(503, 'That corridor is not ready yet.', 'no_deposit_address');
    }

    const tokenInfo = findTokenBySymbol(payout.sourceToken);
    if (!tokenInfo) return fail(400, "I don't recognise that token", 'unknown_token');

    const keyBytes = await decryptPrivateKey(user.encryptedPrivateKey);
    const privateKey = `0x${Buffer.from(keyBytes).toString('hex')}` as Hex;

    const funding = await fundPayout({
      payout,
      privateKey,
      depositAddress: depositAddress as Address,
      token: (tokenInfo.address as Address | null) ?? null,
      tokenInfo,
      rail: context.capability.rail,
    });

    if (funding.status !== 'funding') {
      return ok({
        payoutId: String(payout._id),
        status: funding.status,
        message: STATUS_MESSAGES[funding.status],
        // The only state from which starting over is safe.
        retryable: funding.status === 'funding_failed',
      });
    }

    // Funding is broadcast but not confirmed. Submitting before it lands would
    // ask the provider to pay against money it cannot see yet, so the poller
    // picks this up once a receipt exists.
    return ok({
      payoutId: String(payout._id),
      status: 'funding',
      message: STATUS_MESSAGES.funding,
      retryable: false,
    });
  } catch (e) {
    return handleError('fiat/payout', e);
  }
}

