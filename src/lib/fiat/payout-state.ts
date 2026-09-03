/**
 * The payout state machine.
 *
 * A payout has two legs that can each fail in a way we cannot immediately
 * resolve: stablecoin leaving the wallet on-chain, and the provider paying out
 * fiat at the other end. The states below exist to keep those two kinds of
 * "we do not know" from ever being retried.
 *
 * This generalises a bug the tip path already hit: a partially-paid split was
 * marked `pending`, the retry queue selected it, and it re-sent the whole total
 * to someone already paid. The fix there was inventing a status the retry query
 * did not match. Here that idea is the design rather than a patch — `ACTIONABLE`
 * is an explicit allow-list, and a test asserts it cannot overlap the terminal
 * or frozen sets.
 */

export type PayoutStatus =
  /** Quoted, nothing has moved. The quote can simply expire. */
  | 'quoted'
  /** Funding transaction signed and broadcast. */
  | 'funding'
  /** Stablecoin confirmed on-chain, provider not yet told. */
  | 'funded'
  /** Broadcast, no receipt. May still land — never re-sign. */
  | 'funding_indeterminate'
  /** Definitively nothing moved on-chain. */
  | 'funding_failed'
  /** Provider has been asked to pay. */
  | 'submitted'
  /** The submit call gave no definite answer. Never resubmit blindly. */
  | 'submit_indeterminate'
  /** Provider acknowledged and is working on it. */
  | 'provider_pending'
  | 'paid'
  | 'failed'
  /** Money went out and came back. Recorded, never automated. */
  | 'reversed'
  | 'cancelled';

export const ALL_STATUSES: readonly PayoutStatus[] = [
  'quoted',
  'funding',
  'funded',
  'funding_indeterminate',
  'funding_failed',
  'submitted',
  'submit_indeterminate',
  'provider_pending',
  'paid',
  'failed',
  'reversed',
  'cancelled',
];

/** Nothing moves out of these. */
export const TERMINAL: ReadonlySet<PayoutStatus> = new Set<PayoutStatus>([
  'funding_failed',
  'paid',
  'failed',
  'reversed',
  'cancelled',
]);

/**
 * Automation may *observe* these — read a receipt, ask the provider — but must
 * never initiate a new send or submit on them. A human or the reconciler's
 * narrow, evidence-based rules move them on.
 */
export const FROZEN: ReadonlySet<PayoutStatus> = new Set<PayoutStatus>([
  'funding_indeterminate',
  'submit_indeterminate',
]);

/**
 * The only statuses a background worker may pick up and act on.
 *
 * An allow-list rather than "everything that is not terminal", because the
 * dangerous states are exactly the ones a negation would quietly include.
 */
export const ACTIONABLE: ReadonlySet<PayoutStatus> = new Set<PayoutStatus>([
  'quoted',
  'funded',
  'submitted',
  'provider_pending',
]);

const TRANSITIONS: Readonly<Record<PayoutStatus, readonly PayoutStatus[]>> = {
  quoted: ['funding', 'cancelled'],
  funding: ['funded', 'funding_failed', 'funding_indeterminate'],
  // Resolving an indeterminate funding leg is the reconciler's job, and it may
  // only conclude on evidence: a receipt, or a nonce that another transaction
  // has consumed.
  funding_indeterminate: ['funded', 'funding_failed'],
  funded: ['submitted', 'cancelled'],
  submitted: ['provider_pending', 'submit_indeterminate', 'paid', 'failed'],
  // `funded` is reachable again only when the provider explicitly reports it has
  // no record of our idempotency key — the one safe resubmit in the system.
  submit_indeterminate: ['funded', 'provider_pending', 'paid', 'failed'],
  provider_pending: ['paid', 'failed'],
  paid: ['reversed'],
  funding_failed: [],
  failed: [],
  reversed: [],
  cancelled: [],
};

export function canTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function nextStatuses(from: PayoutStatus): readonly PayoutStatus[] {
  return TRANSITIONS[from];
}

/**
 * Whether a worker may act on a payout in this state.
 *
 * Deliberately not `!TERMINAL.has(s)`. `funding_indeterminate` is neither
 * terminal nor safe, and a negation would sweep it up.
 */
export function isActionable(status: PayoutStatus): boolean {
  return ACTIONABLE.has(status);
}

export function isTerminal(status: PayoutStatus): boolean {
  return TERMINAL.has(status);
}

export function isFrozen(status: PayoutStatus): boolean {
  return FROZEN.has(status);
}

/**
 * A one-line explanation of where a payout stands, for the person waiting on it.
 * The indeterminate states say "do not try again" because that is the single
 * most important thing for them to know.
 */
export const STATUS_MESSAGES: Readonly<Record<PayoutStatus, string>> = {
  quoted: 'Quoted, not sent yet.',
  funding: 'Moving funds on-chain.',
  funded: 'Funds are on-chain, telling our payout partner.',
  funding_indeterminate:
    'We lost contact with the network mid-send. Do not try again — we are checking whether it went through.',
  funding_failed: 'Nothing left your wallet. Safe to try again.',
  submitted: 'Sent to our payout partner.',
  submit_indeterminate:
    'We lost contact with our payout partner. Do not try again — we are checking.',
  provider_pending: 'Your payout partner is processing it.',
  paid: 'Paid.',
  failed: 'It could not be paid out. The funds were returned.',
  reversed: 'The payout was reversed after it settled.',
  cancelled: 'Cancelled before anything moved.',
};
