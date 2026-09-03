import { NextRequest } from 'next/server';
import connectDB from '@/lib/mongodb';
import { requireMachineCaller } from '@/lib/auth';
import { handleError, ok } from '@/lib/api';
import User from '@/models/User';
import Payout from '@/models/Payout';
import { reconcilePayout, submitPayout, transition } from '@/lib/fiat/payouts';
import { classifyConfirmation } from '@/lib/fiat/funding-policy';
import { receiptStatus } from '@/lib/chain';
import { payoutProvider } from '@/lib/fiat/registry';
import { verifiedSubjectFor } from '@/lib/fiat/subject';
import type { Hex } from 'viem';

/**
 * The cron that moves payouts forward.
 *
 * Three jobs, in order of how dangerous they are:
 *
 *  1. Confirm funding legs — read a receipt, nothing more.
 *  2. Submit funded payouts to the provider, under a derived idempotency key.
 *  3. Resolve frozen payouts from evidence only, never by re-sending.
 *
 * Frozen payouts are observed here, and that is the point: automation may look
 * at them, and may conclude from a receipt or a consumed nonce, but there is no
 * path in this file that signs a new transaction or submits a payout twice.
 */

export const maxDuration = 60;

/** How many of each kind per run. Small: this runs often and nothing here is urgent. */
const BATCH = 20;

export async function POST(req: NextRequest) {
  try {
    requireMachineCaller(req);
    await connectDB();

    const confirmed: string[] = [];
    const submitted: string[] = [];
    const resolved: string[] = [];

    // 1. Funding legs awaiting a receipt.
    const funding = await Payout.find({ status: 'funding' })
      .sort({ fundingBroadcastAt: 1 })
      .limit(BATCH);

    for (const payout of funding) {
      if (!payout.fundingHash) continue;
      const decision = classifyConfirmation(await receiptStatus(payout.fundingHash as Hex));
      if (decision.next === 'funding_indeterminate') {
        // Only after long enough that a receipt should have appeared. Before
        // that, "no receipt yet" is just an L2 being an L2.
        const age = Date.now() - (payout.fundingBroadcastAt?.getTime() ?? Date.now());
        if (age < 60_000) continue;
      }
      if (await transition(payout._id, 'funding', decision.next, { note: decision.reason })) {
        confirmed.push(`${String(payout._id)}:${decision.next}`);
      }
    }

    // 2. Funded payouts the provider has not been told about.
    const funded = await Payout.find({ status: 'funded' }).sort({ updatedAt: 1 }).limit(BATCH);

    for (const payout of funded) {
      const provider = payoutProvider(payout.provider);
      if (!provider) continue;

      const user = await User.findById(payout.userId);
      if (!user) continue;

      const subject = verifiedSubjectFor(
        {
          userId: String(user._id),
          verifications: user.verifications,
          payoutCountry: user.payoutCountry,
        },
        provider.name
      );
      if (!subject.ok) {
        // Verification lapsed between quote and submit. The money is already at
        // the provider, so this needs a person rather than a guess.
        await Payout.updateOne(
          { _id: payout._id },
          { $set: { escalatedAt: new Date(), note: subject.message } }
        );
        continue;
      }

      const result = await submitPayout({ payout, provider, subject: subject.subject });
      submitted.push(`${String(payout._id)}:${result.status}`);
    }

    // 3. Frozen payouts, resolved from evidence.
    const frozen = await Payout.find({
      status: { $in: ['funding_indeterminate', 'submit_indeterminate', 'provider_pending'] },
      escalatedAt: { $exists: false },
    })
      .sort({ updatedAt: 1 })
      .limit(BATCH);

    for (const payout of frozen) {
      const result = await reconcilePayout({
        payout,
        provider: payoutProvider(payout.provider),
      });
      resolved.push(`${String(payout._id)}:${result.status}`);
    }

    return ok({ confirmed, submitted, resolved });
  } catch (e) {
    return handleError('fiat/reconcile', e);
  }
}
