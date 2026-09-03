import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileFunding,
  reconcileSubmission,
  ESCALATE_AFTER_MS,
  type FundingEvidence,
} from './reconcile-policy.ts';

/**
 * The only place in the system a double-spend could originate, so it gets the
 * most tests.
 *
 * The rule under all of them: the only permitted retry is rebroadcasting the
 * identical stored bytes. Anything that would cause a *re-signing* — a new
 * nonce, a new transaction — must be unreachable.
 */

const base: FundingEvidence = { receipt: 'missing', txNonce: 7, chainNonce: 7, ageMs: 1000 };

test('a confirmed receipt funds the payout', () => {
  const d = reconcileFunding({ ...base, receipt: 'success' });
  assert.equal(d.next, 'funded');
  assert.equal(d.action, 'none');
});

test('a reverted transaction is a definitive failure, not a retry', () => {
  // It reached a block and failed, so nothing moved and we know it.
  const d = reconcileFunding({ ...base, receipt: 'reverted' });
  assert.equal(d.next, 'funding_failed');
  assert.equal(d.action, 'none');
});

test('a consumed nonce proves the transaction can never land', () => {
  // The insight that lets most indeterminate payouts resolve without a person:
  // if the account's nonce has moved past ours, another transaction took that
  // slot and ours is permanently unincludable.
  const d = reconcileFunding({ ...base, txNonce: 7, chainNonce: 8 });
  assert.equal(d.next, 'funding_failed');
  assert.equal(d.action, 'none');
  assert.match(d.reason, /never land/);
});

test('an unused nonce and a recent broadcast rebroadcasts the same bytes', () => {
  const d = reconcileFunding({ ...base, txNonce: 7, chainNonce: 7, ageMs: 60_000 });
  assert.equal(d.next, 'unchanged');
  assert.equal(d.action, 'rebroadcast');
  // Stated explicitly, because "retry" and "rebroadcast identical bytes" are
  // very different operations and the distinction is the whole safety argument.
  assert.match(d.reason, /identical signed bytes/);
});

test('after a day with no receipt it escalates instead of guessing', () => {
  const d = reconcileFunding({ ...base, ageMs: ESCALATE_AFTER_MS });
  assert.equal(d.next, 'unchanged');
  assert.equal(d.action, 'escalate');
});

test('never concludes success or failure without evidence', () => {
  // The dangerous mistake would be treating a timeout as failure and letting the
  // payout be recreated. Across the whole no-receipt, nonce-unused space, the
  // status must stay unchanged.
  for (const ageMs of [0, 1_000, 3_600_000, ESCALATE_AFTER_MS - 1, ESCALATE_AFTER_MS * 10]) {
    const d = reconcileFunding({ receipt: 'missing', txNonce: 5, chainNonce: 5, ageMs });
    assert.equal(d.next, 'unchanged', `age ${ageMs} must not conclude anything`);
  }
});

test('a nonce far ahead is still a definitive failure', () => {
  const d = reconcileFunding({ ...base, txNonce: 3, chainNonce: 99 });
  assert.equal(d.next, 'funding_failed');
});

test('the nonce check takes precedence over the age check', () => {
  // Even a very old transaction resolves cleanly if the nonce was consumed —
  // evidence beats a timer, and this avoids escalating something answerable.
  const d = reconcileFunding({
    receipt: 'missing',
    txNonce: 4,
    chainNonce: 5,
    ageMs: ESCALATE_AFTER_MS * 5,
  });
  assert.equal(d.next, 'funding_failed');
  assert.equal(d.action, 'none');
});

test('a receipt always beats the nonce heuristic', () => {
  // A confirmed receipt with a moved-on nonce is normal: the nonce advances the
  // moment our own transaction lands.
  const d = reconcileFunding({ receipt: 'success', txNonce: 7, chainNonce: 8, ageMs: 5000 });
  assert.equal(d.next, 'funded');
});

/* ------------------------------------------------------------- submissions */

test('not_found is the only lookup that permits submitting again', () => {
  const d = reconcileSubmission('not_found');
  assert.equal(d.next, 'funded'); // `funded` means "submit"
  assert.match(d.reason, /no record/);

  // Everything else moves forward, never back to a submittable state.
  for (const lookup of ['pending', 'paid', 'failed', 'reversed'] as const) {
    assert.notEqual(
      reconcileSubmission(lookup).next,
      'funded',
      `${lookup} must not permit a resubmit`
    );
  }
});

test('provider verdicts map to the matching terminal state', () => {
  assert.equal(reconcileSubmission('pending').next, 'provider_pending');
  assert.equal(reconcileSubmission('paid').next, 'paid');
  assert.equal(reconcileSubmission('failed').next, 'failed');
  assert.equal(reconcileSubmission('reversed').next, 'reversed');
});

test('no reconciliation ever asks for a re-sign', () => {
  // `rebroadcast` and `none` are the only actions that touch the chain, and
  // `rebroadcast` is defined as replaying stored bytes. There is deliberately no
  // action meaning "sign a fresh transaction".
  const cases: FundingEvidence[] = [
    { receipt: 'success', txNonce: 1, chainNonce: 2, ageMs: 0 },
    { receipt: 'reverted', txNonce: 1, chainNonce: 1, ageMs: 0 },
    { receipt: 'missing', txNonce: 1, chainNonce: 2, ageMs: 0 },
    { receipt: 'missing', txNonce: 1, chainNonce: 1, ageMs: 0 },
    { receipt: 'missing', txNonce: 1, chainNonce: 1, ageMs: ESCALATE_AFTER_MS },
  ];
  for (const c of cases) {
    assert.ok(['none', 'rebroadcast', 'escalate'].includes(reconcileFunding(c).action));
  }
});
