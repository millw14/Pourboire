import { NextRequest } from 'next/server';
import connectDB from '@/lib/mongodb';
import { requireCaller } from '@/lib/auth';
import { check, handleError, ok, rateLimit, tooManyRequests } from '@/lib/api';
import { resolveCallerUser } from '@/lib/wallets';
import Payout from '@/models/Payout';
import { STATUS_MESSAGES, isFrozen, isTerminal } from '@/lib/fiat/payout-state';
import { explorerTxUrl } from '@/lib/chain';

/**
 * Where one payout stands.
 *
 * `retryable` is computed rather than inferred by the client, because getting it
 * wrong is how someone gets paid twice. It is true in exactly one state:
 * `funding_failed`, where nothing left the wallet and starting over is safe.
 */

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const caller = await requireCaller(req);
    if (!rateLimit(`fiat-payout-get:${caller.privyUserId}`, 60, 60_000)) return tooManyRequests();

    await connectDB();
    const user = await resolveCallerUser(caller);
    check(user, 'No tip wallet found for your account');

    const { id } = await params;
    const payout = await Payout.findOne({ _id: id, userId: user._id }).lean();
    check(payout, 'We could not find that payout');

    return ok({
      payoutId: String(payout._id),
      status: payout.status,
      message: STATUS_MESSAGES[payout.status],
      retryable: payout.status === 'funding_failed',
      // Named so nothing downstream has to re-derive what a state means.
      frozen: isFrozen(payout.status),
      settled: isTerminal(payout.status),
      corridorKey: payout.corridorKey,
      sourceAmount: payout.sourceAmount,
      sourceToken: payout.sourceToken,
      quotedDestinationMinor: payout.quotedDestinationMinor,
      // Kept apart from the quote on purpose: a provider paying a different
      // figure than it quoted is a fact worth being able to see.
      settledDestinationMinor: payout.settledDestinationMinor ?? null,
      fundingTx: payout.fundingHash ? explorerTxUrl(payout.fundingHash) : null,
      note: payout.note ?? null,
      createdAt: payout.createdAt,
      updatedAt: payout.updatedAt,
    });
  } catch (e) {
    return handleError('fiat/payout/get', e);
  }
}
