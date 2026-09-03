import 'server-only';
import type { Hex } from 'viem';
import User from '@/models/User';
import GasSponsorship from '@/models/GasSponsorship';
import { nonceAt, receiptStatus } from '../chain.ts';
import { sponsorAddress } from './wallet.ts';
import { counters, release, utcDay } from './sponsor.ts';

/**
 * Resolving gas grants whose outcome was never established.
 *
 * Deliberately a module of its own. `sponsor.ts` can spend the hot wallet and is
 * reachable from exactly three session routes — a fact a test asserts by name.
 * This one only reads receipts and nonces, so the cron can reach it without
 * widening that list, and the difference between "may spend" and "may resolve"
 * stays visible in the import graph rather than living in a comment.
 *
 * A grant that could not be confirmed keeps its per-user lock, so the user is
 * not sponsored again while ETH may be in flight. Without something to release
 * that lock, a single slow RPC response — eight seconds is not long — was a
 * silent, permanent ban, while the routes went on telling the user to try again
 * in a moment for a state no retry could change.
 */

/**
 * How long a frozen grant blocks further sponsorship before its lock is
 * released on age alone.
 */
export const FREEZE_ESCAPE_MS = 10 * 60_000;

/**
 * Evidence only, exactly as the payout reconciler does it. A receipt settles it;
 * a sponsor nonce that has moved past ours proves the grant can never land.
 * There is no path here that re-sends.
 */
export async function reconcileSponsorships(limit = 20): Promise<string[]> {
  const stuck = await GasSponsorship.find({ status: 'indeterminate', active: true })
    .sort({ updatedAt: 1 })
    .limit(limit);

  const resolved: string[] = [];

  for (const row of stuck) {
    if (!row.txHash) {
      // Nothing was ever signed, so nothing can be in flight. Safe to clear.
      await release(row._id, 'No transaction was recorded');
      resolved.push(`${String(row._id)}:failed`);
      continue;
    }

    const receipt = await receiptStatus(row.txHash as Hex);

    if (receipt === 'success') {
      await GasSponsorship.updateOne(
        { _id: row._id },
        {
          $set: { status: 'confirmed', note: 'Confirmed on reconciliation' },
          $unset: { active: '' },
        }
      );
      // The ETH did arrive, so it counts against what the user may withdraw,
      // exactly as it would have at grant time.
      const user = await User.findById(row.userId);
      if (user) {
        const own = counters(user, utcDay(new Date()));
        await User.updateOne(
          { _id: user._id },
          {
            $set: {
              'gasSponsored.outstandingWei': (
                own.outstandingWei + BigInt(row.amountWei)
              ).toString(),
            },
          }
        );
      }
      resolved.push(`${String(row._id)}:confirmed`);
      continue;
    }

    if (receipt === 'reverted') {
      await release(row._id, 'Grant reverted');
      resolved.push(`${String(row._id)}:failed`);
      continue;
    }

    // No receipt. The sponsor's nonce settles it: if the account has moved past
    // the nonce this grant was signed with, another transaction took the slot
    // and ours can never be included.
    const sponsor = sponsorAddress();
    if (sponsor && row.txNonce !== undefined) {
      const chainNonce = await nonceAt(sponsor);
      if (chainNonce > row.txNonce) {
        await release(row._id, `Nonce ${row.txNonce} was consumed elsewhere; this cannot land`);
        resolved.push(`${String(row._id)}:failed`);
        continue;
      }
    }

    const age = Date.now() - (row.broadcastAt?.getTime() ?? row.createdAt.getTime());
    if (age >= FREEZE_ESCAPE_MS) {
      // Long past when a receipt should have appeared, and the nonce is still
      // unused. Release the LOCK so the user is not stranded, but leave the
      // counters charged and the status indeterminate — we still cannot prove
      // nothing was spent, and pretending otherwise is how a budget leaks.
      await GasSponsorship.updateOne(
        { _id: row._id },
        {
          $set: { note: 'Lock released on age; outcome still unknown' },
          $unset: { active: '' },
        }
      );
      resolved.push(`${String(row._id)}:released`);
    }
  }

  return resolved;
}
