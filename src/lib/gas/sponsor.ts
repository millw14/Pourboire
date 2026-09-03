import 'server-only';
import type { Address, Hex } from 'viem';
import User, { type IUser } from '@/models/User';
import GasSponsorship from '@/models/GasSponsorship';
import GasBudget from '@/models/GasBudget';
import { broadcastRaw, getPublicClient, nativeBalance, signTransfer } from '../chain.ts';
import { sponsorAddress, sponsorConfigured, withSponsorKey } from './wallet.ts';
import {
  DEFAULT_LIMITS,
  decideSponsorship,
  ratchetOutstanding,
  weiToGweiCeil,
  type SponsorIntent,
  type SponsorRefusal,
} from './policy.ts';

/**
 * Putting gas into a user's wallet so they can move the money they were tipped.
 *
 * The decision lives in `./policy.ts` and is pure. This is the I/O around it,
 * deliberately thin, and it exists at all because a hot wallet that signs on its
 * own needs its whole sequence written down in one place:
 *
 *   decide -> claim the per-user lock -> reserve the global budget ->
 *   sign -> record -> broadcast -> confirm -> release or freeze
 *
 * Counters are reserved BEFORE the broadcast and released only on proof that
 * nothing left the sponsor wallet. A grant that comes back indeterminate keeps
 * both its lock and its reservation, which stops that user being granted again
 * until someone establishes what happened — the same discipline the payout path
 * uses, for the same reason.
 */

/** How long to wait for a grant to confirm. Blocks are ~100ms; this is generous. */
export const SPONSOR_CONFIRM_MS = 8_000;

export type SponsorResult =
  /** Gas is in the wallet — either it already was, or we just put it there. */
  | { ok: true; granted: bigint }
  | { ok: false; reason: SponsorRefusal | 'in_flight' | 'send_failed'; message: string };

export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Counters for this user, with the day rolled over if it is stale. */
export function counters(user: IUser, day: string) {
  const stored = user.gasSponsored;
  const sameDay = stored?.day === day;
  return {
    outstandingWei: BigInt(stored?.outstandingWei ?? '0'),
    todayWei: sameDay ? BigInt(stored?.todayWei ?? '0') : 0n,
    lifetimeWei: BigInt(stored?.lifetimeWei ?? '0'),
  };
}

/**
 * Ensure the wallet can pay `requiredWei` of gas, sponsoring the shortfall.
 *
 * Returns `ok` when the wallet can pay — including when it already could, in
 * which case nothing was granted and nothing was spent. Every refusal carries a
 * sentence the caller can show verbatim.
 */
export async function ensureGasFor(params: {
  user: IUser;
  intent: SponsorIntent;
  /** Gas limit times gas price for the transaction about to be attempted. */
  requiredWei: bigint;
  /** Present only for a signed-in, user-initiated action. Never defaulted. */
  signedInAs?: string;
  at?: Date;
}): Promise<SponsorResult> {
  const { user, intent, requiredWei } = params;
  const now = params.at ?? new Date();
  const day = utcDay(now);
  const wallet = user.walletAddress as Address;

  const configured = sponsorConfigured();
  const sponsor = sponsorAddress();

  // The wallet's own balance answers most calls on its own, so it is read first
  // and alone. A funded wallet costs one RPC call and never touches the rest of
  // this — including when sponsorship is switched off entirely, where the
  // earlier version read four balances to reach a conclusion it already had.
  const balanceWei = await nativeBalance(wallet);
  if (balanceWei >= requiredWei) return { ok: true, granted: 0n };

  if (!configured) {
    return {
      ok: false,
      reason: 'unconfigured',
      message: 'Not enough ETH to cover gas. Top up a little ETH and try again.',
    };
  }

  const [gasPriceWei, sponsorBalanceWei, globalSpentGwei] = await Promise.all([
    getPublicClient().getGasPrice(),
    sponsor ? nativeBalance(sponsor) : Promise.resolve(0n),
    GasBudget.findById(`gas:${day}`)
      .lean()
      .then((doc) => BigInt(doc?.spentGwei ?? 0)),
  ]);

  const own = counters(user, day);
  const decision = decideSponsorship({
    intent,
    balanceWei,
    requiredWei,
    userSpentTodayWei: own.todayWei,
    userSpentLifetimeWei: own.lifetimeWei,
    globalSpentTodayWei: globalSpentGwei * 1_000_000_000n,
    sponsorBalanceWei,
    gasPriceWei,
    signedIn: Boolean(params.signedInAs),
    configured,
    limits: DEFAULT_LIMITS,
  });

  if (!decision.sponsor) {
    // `not_needed` is the ordinary case, not a failure — the wallet can pay.
    if (decision.reason === 'not_needed') return { ok: true, granted: 0n };
    return { ok: false, reason: decision.reason, message: decision.message };
  }

  const amountWei = decision.amountWei;
  return grant({ user, intent, wallet, amountWei, gasPriceWei, balanceBeforeWei: balanceWei, day, now });
}

/**
 * Claim, reserve, sign, send.
 *
 * Split out so the decision above reads as a decision. Every early return here
 * unwinds exactly what it claimed and nothing more.
 */
/**
 * The lock the whole sequence hangs on.
 *
 * `grantInner` claims a row with `active: true`, and every step after that is an
 * await that can throw — an RPC 502 inside `signTransfer` is enough. An escaping
 * exception used to leave the row claimed forever with nothing anywhere that
 * would clear it, so one bad second permanently banned that user from being
 * sponsored again and left the budget charged for a grant that never happened.
 *
 * Every throw here happens BEFORE the broadcast or in the same breath as it, so
 * unwinding is safe: the only paths that must not unwind are the ones that
 * return normally having frozen the row on purpose.
 */
async function grant(params: Parameters<typeof grantInner>[0]): Promise<SponsorResult> {
  try {
    return await grantInner(params);
  } catch (e) {
    const day = params.day;
    const amountGwei = weiToGweiCeil(params.amountWei);
    await GasSponsorship.updateOne(
      { userId: params.user._id, active: true },
      { $set: { status: 'failed', note: 'Unwound after an error before broadcast' }, $unset: { active: '' } }
    ).catch(() => {});
    await refundCounters({
      user: params.user,
      day,
      before: counters(params.user, day),
      amountGwei,
    }).catch(() => {});
    throw e;
  }
}

async function grantInner(params: {
  user: IUser;
  intent: SponsorIntent;
  wallet: Address;
  amountWei: bigint;
  gasPriceWei: bigint;
  /** What the wallet held before this grant, for ratcheting the lock. */
  balanceBeforeWei: bigint;
  day: string;
  now: Date;
}): Promise<SponsorResult> {
  const { user, intent, wallet, amountWei, gasPriceWei, balanceBeforeWei, day, now } = params;

  // One grant per user per intent per minute. The `active` index below already
  // blocks concurrent grants; this additionally makes a double-clicked button
  // idempotent across a grant that has already completed.
  const requestKey = `${String(user._id)}:${intent}:${Math.floor(now.getTime() / 60_000)}`;

  let sponsorship;
  try {
    sponsorship = await GasSponsorship.create({
      userId: user._id,
      wallet: wallet.toLowerCase(),
      intent,
      status: 'reserved',
      active: true,
      requestKey,
      amountWei: amountWei.toString(),
      gasPriceWei: gasPriceWei.toString(),
    });
  } catch (e) {
    // Either the per-user `active` index or the `requestKey` index refused.
    // Both mean the same thing to the caller: something is already happening.
    if ((e as { code?: number })?.code === 11000) {
      return {
        ok: false,
        reason: 'in_flight',
        message: 'We are already sending you gas. Try again in a moment.',
      };
    }
    throw e;
  }

  // The global cap, reserved with one filtered atomic update. The filter carries
  // the ceiling, so a day that would exceed it simply does not match — there is
  // no read to race against, and a miss IS the refusal.
  const amountGwei = weiToGweiCeil(amountWei);
  const capGwei = weiToGweiCeil(DEFAULT_LIMITS.globalDailyWei);
  const budget = await GasBudget.findOneAndUpdate(
    { _id: `gas:${day}`, spentGwei: { $not: { $gt: capGwei - amountGwei } } },
    { $inc: { spentGwei: amountGwei } },
    { upsert: true, new: true }
  ).catch((e: { code?: number }) => {
    // On an upsert race the loser gets a duplicate _id rather than a match.
    if (e?.code === 11000) return null;
    throw e;
  });

  if (!budget) {
    await release(sponsorship._id, 'Global daily gas budget reached');
    return {
      ok: false,
      reason: 'global_daily_cap',
      message: 'We cannot cover gas right now. Try again shortly.',
    };
  }

  // Reserved before anything is signed, and charged whether or not the user's
  // own transaction later succeeds — the ETH has left the sponsor either way.
  const own = counters(user, day);
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        'gasSponsored.day': day,
        'gasSponsored.todayWei': (own.todayWei + amountWei).toString(),
        'gasSponsored.lifetimeWei': (own.lifetimeWei + amountWei).toString(),
        'gasSponsored.outstandingWei': own.outstandingWei.toString(),
      },
    }
  );

  const signed = withSponsorKey((key) =>
    signTransfer({ privateKey: key, to: wallet, amount: amountWei, token: null })
  );
  if (!signed) {
    await release(sponsorship._id, 'Sponsor key unavailable at signing time');
    await refundCounters({ user, day, before: own, amountGwei });
    return {
      ok: false,
      reason: 'unconfigured',
      message: 'Not enough ETH to cover gas. Top up a little ETH and try again.',
    };
  }

  const tx = await signed;

  // Written before the broadcast, so an unanswered send still leaves something
  // to look up rather than a grant nobody can account for.
  await GasSponsorship.updateOne(
    { _id: sponsorship._id, status: 'reserved' },
    {
      $set: {
        status: 'sending',
        txHash: tx.hash,
        txNonce: tx.nonce,
        rawTx: tx.raw,
        broadcastAt: new Date(),
      },
    }
  );

  const sent = await broadcastRaw(tx.raw);
  if (!sent.ok) {
    if (sent.definite) {
      // Refused before the mempool — nothing left the sponsor wallet, so the
      // reservation comes back. A nonce collision with a concurrent grant lands
      // here, which is why a collision costs a retry rather than any money.
      await release(sponsorship._id, sent.reason);
      await refundCounters({ user, day, before: own, amountGwei });
      return {
        ok: false,
        reason: 'send_failed',
        message: 'We could not cover gas just now. Try again in a moment.',
      };
    }
    await freeze(sponsorship._id, sent.reason);
    return {
      ok: false,
      reason: 'send_failed',
      message: 'We are still sending you gas. Try again in a moment.',
    };
  }

  try {
    const receipt = await getPublicClient().waitForTransactionReceipt({
      hash: tx.hash as Hex,
      timeout: SPONSOR_CONFIRM_MS,
    });
    if (receipt.status !== 'success') {
      await release(sponsorship._id, 'Grant reverted');
      await refundCounters({ user, day, before: own, amountGwei });
      return {
        ok: false,
        reason: 'send_failed',
        message: 'We could not cover gas just now. Try again in a moment.',
      };
    }
  } catch {
    // Broadcast but not seen in time. It will very likely land, so the grant is
    // NOT retried and the reservation stays charged. The user waits.
    await freeze(sponsorship._id, 'No receipt within the confirmation window');
    return {
      ok: false,
      reason: 'send_failed',
      message: 'Gas is on its way. Give it a moment and try again.',
    };
  }

  // Confirmed. The grant is now spendable gas, and outstanding until spent.
  await GasSponsorship.updateOne(
    { _id: sponsorship._id },
    { $set: { status: 'confirmed' }, $unset: { active: '' } }
  );
  // Ratchet the stored figure against the balance BEFORE this grant landed,
  // then add the grant. Without the ratchet, outstanding only ever grew — a user
  // who legitimately spent every grant on their own transactions would still
  // have the full lifetime total locked against them, and a later tip of real
  // ETH would be unwithdrawable up to that amount.
  const settled = ratchetOutstanding(own.outstandingWei, balanceBeforeWei) + amountWei;
  await User.updateOne(
    { _id: user._id },
    { $set: { 'gasSponsored.outstandingWei': settled.toString() } }
  );

  return { ok: true, granted: amountWei };
}

/** Nothing moved. Clear the lock so the user may be granted again. */
export async function release(id: unknown, note: string) {
  await GasSponsorship.updateOne(
    { _id: id },
    { $set: { status: 'failed', note }, $unset: { active: '' } }
  );
}

/**
 * Something may have moved. Keep the lock, which blocks further grants to this
 * user until a person or a reconciler establishes what happened.
 */
async function freeze(id: unknown, note: string) {
  await GasSponsorship.updateOne({ _id: id }, { $set: { status: 'indeterminate', note } });
}

/**
 * Give back a reservation, but only ever on proof that nothing was spent.
 *
 * Restores the pre-grant values rather than subtracting, because the in-memory
 * user document is the one loaded before the increment — recomputing from it
 * and subtracting would take the amount off twice. Safe to restore rather than
 * decrement because the per-user active lock means no other grant for this user
 * can have moved these numbers in between.
 */
async function refundCounters(params: {
  user: IUser;
  day: string;
  before: { todayWei: bigint; lifetimeWei: bigint };
  amountGwei: number;
}) {
  await Promise.all([
    User.updateOne(
      { _id: params.user._id },
      {
        $set: {
          'gasSponsored.todayWei': params.before.todayWei.toString(),
          'gasSponsored.lifetimeWei': params.before.lifetimeWei.toString(),
        },
      }
    ),
    GasBudget.updateOne({ _id: `gas:${params.day}` }, { $inc: { spentGwei: -params.amountGwei } }),
  ]);
}
