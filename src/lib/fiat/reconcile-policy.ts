import type { PayoutStatus } from './payout-state.ts';

/**
 * Resolving a payout whose funding leg is in doubt.
 *
 * This is the most dangerous decision in the system and therefore the smallest,
 * purest module: given evidence, what is safe to conclude? It makes no network
 * calls and touches no database, so every branch is testable.
 *
 * The rule it exists to enforce: **a retry may only ever rebroadcast the
 * identical stored bytes.** Same bytes means the same hash, and the chain
 * deduplicates. Re-*signing* produces a second transaction with a second nonce,
 * and if the first one lands too, the money goes twice.
 */

export type ReceiptStatus = 'success' | 'reverted' | 'missing';

export interface FundingEvidence {
  receipt: ReceiptStatus;
  /** Nonce of the transaction we signed. */
  txNonce: number;
  /** The sender's current on-chain nonce (`getTransactionCount(..., 'latest')`). */
  chainNonce: number;
  /** How long ago it was broadcast. */
  ageMs: number;
}

export type ReconcileAction =
  | 'none'
  /** Push the identical stored raw transaction again. Never re-sign. */
  | 'rebroadcast'
  /** Out of safe options; a person must look. */
  | 'escalate';

export interface ReconcileDecision {
  next: PayoutStatus | 'unchanged';
  action: ReconcileAction;
  /** Why, in words, for the operator reading a stuck payout. */
  reason: string;
}

/** After this long with no receipt, stop guessing and ask a human. */
export const ESCALATE_AFTER_MS = 24 * 60 * 60 * 1000;

export function reconcileFunding(evidence: FundingEvidence): ReconcileDecision {
  const { receipt, txNonce, chainNonce, ageMs } = evidence;

  if (receipt === 'success') {
    return { next: 'funded', action: 'none', reason: 'The funding transaction confirmed.' };
  }

  if (receipt === 'reverted') {
    // It made it into a block and failed. Nothing moved, definitively.
    return {
      next: 'funding_failed',
      action: 'none',
      reason: 'The funding transaction reverted, so nothing left the wallet.',
    };
  }

  // No receipt. The nonce is what turns this from a guess into a fact.
  //
  // If the account's nonce has already moved past ours, some *other*
  // transaction consumed that slot — ours can never be included, at any point in
  // the future. That is a definitive failure rather than a timeout, and it is
  // what lets most indeterminate payouts resolve without a person.
  if (chainNonce > txNonce) {
    return {
      next: 'funding_failed',
      action: 'none',
      reason: `Nonce ${txNonce} was consumed by another transaction (account is now at ${chainNonce}), so this one can never land.`,
    };
  }

  if (ageMs >= ESCALATE_AFTER_MS) {
    return {
      next: 'unchanged',
      action: 'escalate',
      reason:
        'No receipt after 24 hours and the nonce is still unused. Needs a human before anything else is sent.',
    };
  }

  return {
    next: 'unchanged',
    action: 'rebroadcast',
    reason:
      'Still no receipt and the nonce is unused, so the transaction may simply have been dropped. Rebroadcasting the identical signed bytes — same hash, so the chain will not duplicate it.',
  };
}

/**
 * What the provider says about a submission we never got an answer for.
 *
 * `not_found` is the only case that permits a resubmit anywhere in this system,
 * and only because the provider has explicitly stated it holds no record of our
 * idempotency key.
 */
export type ProviderLookup = 'not_found' | 'pending' | 'paid' | 'failed' | 'reversed';

export function reconcileSubmission(lookup: ProviderLookup): ReconcileDecision {
  switch (lookup) {
    case 'not_found':
      return {
        next: 'funded',
        action: 'none',
        reason:
          'The provider has no record of this idempotency key, so the submission never arrived. Safe to submit again.',
      };
    case 'pending':
      return { next: 'provider_pending', action: 'none', reason: 'The provider is processing it.' };
    case 'paid':
      return { next: 'paid', action: 'none', reason: 'The provider reports it as paid.' };
    case 'failed':
      return { next: 'failed', action: 'none', reason: 'The provider reports it as failed.' };
    case 'reversed':
      return { next: 'reversed', action: 'none', reason: 'The provider reports it as reversed.' };
  }
}
