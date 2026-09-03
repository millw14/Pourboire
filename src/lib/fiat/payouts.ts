import 'server-only';
import type { Address, Hex } from 'viem';
import Payout, { type IPayout } from '@/models/Payout';
import { broadcastRaw, nonceAt, receiptStatus, signTransfer } from '../chain';
import { canTransition, isTerminal, type PayoutStatus } from './payout-state.ts';
import { classifyBroadcast } from './funding-policy.ts';
import { reconcileFunding, reconcileSubmission } from './reconcile-policy.ts';
import { ProviderError, type PayoutProvider } from './types.ts';
import type { VerifiedSubject } from './subject.ts';
import {
  checkSettlementToken,
  type SettlementCandidate,
  type SettlementRailToken,
} from './settlement-token.ts';

/**
 * Driving a payout through its states.
 *
 * Every status change goes through `transition`, which is a compare-and-swap:
 * `updateOne({ _id, status: from })` and a check on `matchedCount`. Never a read
 * followed by a write — that is how two workers both decide the same payout is
 * ready to fund, and it is the shape of every double-spend this system could
 * have.
 *
 * The decisions themselves live in the pure modules next door. This file is the
 * I/O around them, deliberately thin, because anything that needs a database or
 * an RPC to test does not get tested.
 */

/**
 * Attempt a state change. Returns false if someone else got there first.
 *
 * A false is not an error — it means the payout has already moved on, and the
 * caller should stop rather than retry.
 */
export async function transition(
  id: unknown,
  from: PayoutStatus,
  to: PayoutStatus,
  patch: Record<string, unknown> = {}
): Promise<boolean> {
  if (!canTransition(from, to)) {
    // A programming error, not a race. Refuse loudly rather than writing a state
    // the machine says is impossible.
    throw new Error(`Illegal payout transition ${from} -> ${to}`);
  }

  const update: Record<string, unknown> = { $set: { status: to, ...patch } };
  if (isTerminal(to)) {
    // Releases the one-active-payout slot. Unset rather than set to false, so
    // the partial unique index stops seeing this document at all.
    update.$unset = { active: '' };
  }

  const result = await Payout.updateOne({ _id: id, status: from }, update);
  return result.matchedCount === 1;
}

/**
 * Move the stablecoin to the provider's deposit address.
 *
 * Signs first, writes the hash and nonce, and only then broadcasts. If the
 * process dies at any point after this function is entered, the row names
 * exactly which transaction to go looking for — which is what makes every
 * failure here recoverable by machine rather than by hand.
 */
export async function fundPayout(params: {
  payout: IPayout;
  privateKey: Hex;
  depositAddress: Address;
  token: Address | null;
  /** What the token actually is, so an equity can be refused. */
  tokenInfo: SettlementCandidate;
  /** What the corridor declared it settles in. */
  rail: SettlementRailToken;
}): Promise<{ status: PayoutStatus; reason: string }> {
  const { payout } = params;

  // The single choke point for every token the fiat layer moves. The route
  // checks earlier and more cheaply, but this is the one that cannot be
  // bypassed by a new caller — and it is the only place that knows the rail, so
  // it is the only place the byte-exact comparison can be made.
  const settlement = checkSettlementToken(params.tokenInfo, params.rail);
  if (!settlement.ok) {
    await transition(payout._id, 'quoted', 'cancelled', { note: settlement.message });
    return { status: 'cancelled', reason: settlement.message };
  }

  const signed = await signTransfer({
    privateKey: params.privateKey,
    to: params.depositAddress,
    amount: BigInt(payout.sourceAmount),
    token: params.token,
  });

  // Written BEFORE the broadcast, and the transition is what claims the payout.
  // If another worker has already funded this one, we stop here having sent
  // nothing.
  const claimed = await transition(payout._id, 'quoted', 'funding', {
    fundingFrom: signed.from,
    fundingHash: signed.hash,
    fundingNonce: signed.nonce,
    fundingRawTx: signed.raw,
    fundingBroadcastAt: new Date(),
  });
  if (!claimed) {
    return { status: payout.status, reason: 'This payout is already being funded.' };
  }

  const outcome = await broadcastRaw(signed.raw);
  const decision = classifyBroadcast(
    outcome.ok ? { ok: true } : { ok: false, message: outcome.reason },
    { rebroadcast: false }
  );

  if (decision.next !== 'funding') {
    await transition(payout._id, 'funding', decision.next, { note: decision.reason });
    return { status: decision.next, reason: decision.reason };
  }

  // Accepted. Whether it confirms is a separate question, answered by the
  // reconciler rather than by blocking here.
  return { status: 'funding', reason: decision.reason };
}

/**
 * Ask the provider to pay.
 *
 * The idempotency key is derived from the quote, so a retry of the same payout
 * is the same key by construction and no client can influence it. A refusal is
 * only treated as a failure when the provider says it is definite; anything else
 * freezes, because a timeout tells us nothing about whether it was accepted.
 */
export async function submitPayout(params: {
  payout: IPayout;
  provider: PayoutProvider;
  subject: VerifiedSubject;
}): Promise<{ status: PayoutStatus; reason: string }> {
  const { payout, provider } = params;

  const claimed = await transition(payout._id, 'funded', 'submitted');
  if (!claimed) {
    return { status: payout.status, reason: 'This payout has already been submitted.' };
  }

  try {
    const submission = await provider.createPayout({
      subject: params.subject,
      quoteId: payout.quoteId,
      destinationRef: payout.destinationRef,
      idempotencyKey: payout.idemKey,
    });

    const next: PayoutStatus =
      submission.status === 'paid'
        ? 'paid'
        : submission.status === 'failed'
          ? 'failed'
          : 'provider_pending';

    await transition(payout._id, 'submitted', next, {
      providerRef: submission.providerRef,
      note: submission.reason,
    });
    return { status: next, reason: submission.reason ?? 'Submitted.' };
  } catch (e) {
    const refusal =
      e instanceof ProviderError
        ? e.refusal
        : { definite: false, message: (e as Error)?.message ?? String(e) };

    if (refusal.definite) {
      // The provider refused before doing anything, so nothing is owed and the
      // funds can be recovered by a new payout.
      await transition(payout._id, 'submitted', 'failed', { note: refusal.message });
      return { status: 'failed', reason: refusal.message };
    }

    // The dangerous case, and the reason this state exists. It may have been
    // accepted. Resubmitting is how someone gets paid twice.
    await transition(payout._id, 'submitted', 'submit_indeterminate', { note: refusal.message });
    return {
      status: 'submit_indeterminate',
      reason: refusal.message,
    };
  }
}

/**
 * Resolve one frozen payout, using evidence only.
 *
 * Called by the reconcile cron. Every branch either concludes from something
 * observed — a receipt, a consumed nonce, the provider's own record — or leaves
 * the payout exactly where it is. It never re-signs and never resubmits.
 */
export async function reconcilePayout(params: {
  payout: IPayout;
  provider: PayoutProvider | null;
}): Promise<{ status: PayoutStatus | 'unchanged'; reason: string }> {
  const { payout } = params;

  if (payout.status === 'funding' || payout.status === 'funding_indeterminate') {
    if (!payout.fundingHash || payout.fundingNonce === undefined) {
      // Should be unreachable: the hash is written before the broadcast. If it
      // ever happens, a person has to look, because there is nothing to look up.
      await Payout.updateOne({ _id: payout._id }, { $set: { escalatedAt: new Date() } });
      return { status: 'unchanged', reason: 'No funding hash recorded. Escalated.' };
    }

    const [receipt, chainNonce] = await Promise.all([
      receiptStatus(payout.fundingHash as Hex),
      // Without a sender we cannot read a nonce, so fall back to our own — which
      // makes `reconcileFunding` treat the nonce as unused and decide on the
      // receipt and the clock instead. Conservative in the safe direction.
      payout.fundingFrom
        ? nonceAt(payout.fundingFrom as Address)
        : Promise.resolve(payout.fundingNonce),
    ]);

    const decision = reconcileFunding({
      receipt,
      txNonce: payout.fundingNonce,
      chainNonce,
      ageMs: Date.now() - (payout.fundingBroadcastAt?.getTime() ?? Date.now()),
    });

    if (decision.action === 'escalate') {
      await Payout.updateOne({ _id: payout._id }, { $set: { escalatedAt: new Date() } });
      return { status: 'unchanged', reason: decision.reason };
    }

    if (decision.action === 'rebroadcast' && payout.fundingRawTx) {
      // The identical stored bytes. Same hash, so the chain deduplicates — this
      // is the only retry the system permits anywhere.
      const outcome = await broadcastRaw(payout.fundingRawTx as Hex);
      const classified = classifyBroadcast(
        outcome.ok ? { ok: true } : { ok: false, message: outcome.reason },
        { rebroadcast: true }
      );
      if (classified.next !== 'funding' && canTransition(payout.status, classified.next)) {
        await transition(payout._id, payout.status, classified.next, { note: classified.reason });
        return { status: classified.next, reason: classified.reason };
      }
      return { status: 'unchanged', reason: classified.reason };
    }

    if (decision.next !== 'unchanged' && canTransition(payout.status, decision.next)) {
      await transition(payout._id, payout.status, decision.next, { note: decision.reason });
      return { status: decision.next, reason: decision.reason };
    }
    return { status: 'unchanged', reason: decision.reason };
  }

  if (payout.status === 'submit_indeterminate' || payout.status === 'provider_pending') {
    if (!params.provider) {
      return { status: 'unchanged', reason: 'That provider is not configured.' };
    }
    const submission = await params.provider.getPayoutByKey(payout.idemKey);
    const decision = reconcileSubmission(submission ? submission.status : 'not_found');

    if (decision.next !== 'unchanged' && canTransition(payout.status, decision.next)) {
      await transition(payout._id, payout.status, decision.next, {
        note: decision.reason,
        ...(submission?.providerRef ? { providerRef: submission.providerRef } : {}),
      });
      return { status: decision.next, reason: decision.reason };
    }
    return { status: 'unchanged', reason: decision.reason };
  }

  return { status: 'unchanged', reason: 'Nothing to reconcile in this state.' };
}
