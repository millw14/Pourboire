import type { PayoutStatus } from './payout-state.ts';
import type { ReceiptStatus } from './reconcile-policy.ts';

/**
 * What a broadcast result means for the funding leg of a payout.
 *
 * Pure, because this is the decision that separates "nothing moved, offer a
 * retry" from "something may be in flight, freeze it". Getting it wrong in
 * either direction is expensive: too eager and money goes twice, too cautious
 * and every dropped socket needs a person.
 *
 * The important difference from `chain.ts`'s `transfer()` is that a payout signs
 * *before* it broadcasts. The hash and nonce are known and persisted before the
 * network is touched, so the `unknown`-with-no-hash case cannot arise here — an
 * indeterminate broadcast is always reconcilable, because we know exactly what
 * to look for.
 */

/** What `eth_sendRawTransaction` came back with. */
export type BroadcastResult = { ok: true } | { ok: false; message: string };

export interface FundingDecision {
  next: Extract<PayoutStatus, 'funding' | 'funding_failed' | 'funding_indeterminate'>;
  reason: string;
}

/**
 * Node responses that mean the transaction was refused *before* entering the
 * mempool. Nothing of ours can land, so the payout failed cleanly.
 *
 * `replacement transaction underpriced` belongs here and is worth stating: it
 * means some *other* transaction already holds our nonce, so ours was never
 * accepted and never will be.
 */
const REFUSED_BEFORE_MEMPOOL = [
  'insufficient funds',
  'intrinsic gas too low',
  'exceeds block gas limit',
  'replacement transaction underpriced',
  'transaction underpriced',
  'gas price too low',
];

/**
 * Responses that mean our exact bytes are already live — the node is telling us
 * it has them, not refusing them.
 *
 * `chain.ts` treats `already known` as indeterminate — the node holds our exact
 * bytes, so the transaction is live and must not be retried. Here we know more
 * than that: we are deliberately replaying stored bytes, so it is not merely
 * "something may be in flight", it is confirmation that this specific
 * transaction is. That is why this list is consulted first, before anything
 * else, and why it resolves to `funding` rather than to a frozen state.
 */
const ALREADY_IN_MEMPOOL = ['already known', 'known transaction', 'already exists'];

/**
 * Classify a broadcast.
 *
 * `rebroadcast` matters because the same message means different things on a
 * first send and a replay — see `ALREADY_IN_MEMPOOL`.
 */
export function classifyBroadcast(
  result: BroadcastResult,
  options: { rebroadcast: boolean }
): FundingDecision {
  if (result.ok) {
    return { next: 'funding', reason: 'Broadcast accepted, waiting for a receipt.' };
  }

  const message = result.message.toLowerCase();

  if (ALREADY_IN_MEMPOOL.some((m) => message.includes(m))) {
    return {
      next: 'funding',
      reason: 'The node already holds this exact transaction, so it is live. Waiting for a receipt.',
    };
  }

  if (message.includes('nonce too low')) {
    // Our nonce has been consumed. By us, if the transaction quietly mined; by
    // something else, if it did not. The broadcast cannot tell them apart, but
    // the receipt can, so this goes to the reconciler rather than being guessed.
    if (options.rebroadcast) {
      return {
        next: 'funding_indeterminate',
        reason:
          'The nonce is already used — this may be our own transaction having mined. Checking the receipt before concluding.',
      };
    }
    // On a first broadcast we have never had bytes accepted, so a used nonce
    // means our transaction was built against a stale count and was refused.
    return {
      next: 'funding_failed',
      reason: 'The nonce was already used, so this transaction was refused and nothing moved.',
    };
  }

  if (REFUSED_BEFORE_MEMPOOL.some((m) => message.includes(m))) {
    return {
      next: 'funding_failed',
      reason: `The network refused the transaction (${result.message}), so nothing left the wallet.`,
    };
  }

  // A timeout, a dropped socket, a 502 at the RPC edge. The sequencer may have
  // accepted it. This is the case that must never become a retry.
  return {
    next: 'funding_indeterminate',
    reason: `No answer from the network (${result.message}). The transaction may still land, so it will be reconciled rather than re-sent.`,
  };
}

export interface ConfirmationDecision {
  next: Extract<PayoutStatus, 'funded' | 'funding_failed' | 'funding_indeterminate'>;
  reason: string;
}

/** Once a receipt exists there is nothing left to interpret. */
export function classifyConfirmation(receipt: ReceiptStatus): ConfirmationDecision {
  switch (receipt) {
    case 'success':
      return { next: 'funded', reason: 'The funding transaction confirmed.' };
    case 'reverted':
      return {
        next: 'funding_failed',
        reason: 'The funding transaction reverted, so nothing left the wallet.',
      };
    case 'missing':
      return {
        next: 'funding_indeterminate',
        reason: 'Broadcast but not yet seen in a block.',
      };
  }
}
