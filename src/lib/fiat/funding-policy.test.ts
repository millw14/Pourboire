import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBroadcast, classifyConfirmation } from './funding-policy.ts';

const fresh = { rebroadcast: false };
const replay = { rebroadcast: true };

test('an accepted broadcast is funding, not funded', () => {
  // Accepted only means the node took it. Nothing is funded until a receipt says so.
  assert.equal(classifyBroadcast({ ok: true }, fresh).next, 'funding');
});

test('definite refusals fail the payout cleanly', () => {
  for (const message of [
    'insufficient funds for gas * price + value',
    'intrinsic gas too low',
    'exceeds block gas limit',
    'replacement transaction underpriced',
  ]) {
    assert.equal(
      classifyBroadcast({ ok: false, message }, fresh).next,
      'funding_failed',
      message
    );
  }
});

test('"already known" is a live transaction on a replay, never a failure', () => {
  // The same string chain.ts treats as a definite rejection. There it is safe,
  // because a retry re-signs identical bytes. Here we are deliberately replaying
  // stored bytes, so it is the node confirming it already holds them — marking
  // that failed would declare a live transaction dead and invite a second one.
  for (const message of ['already known', 'known transaction: 0xabc', 'already exists']) {
    assert.equal(classifyBroadcast({ ok: false, message }, replay).next, 'funding', message);
  }
});

test('a lost socket freezes rather than failing', () => {
  // The sequencer may have accepted it. This is the exact case that must never
  // become an automatic retry.
  for (const message of ['socket hang up', 'request timed out', 'HTTP 502 Bad Gateway', '']) {
    assert.equal(
      classifyBroadcast({ ok: false, message }, fresh).next,
      'funding_indeterminate',
      JSON.stringify(message)
    );
  }
});

test('an unknown error is never treated as failure', () => {
  // Failing closed here would be failing *open* for money: `funding_failed` is
  // the state that permits a fresh payout.
  const decision = classifyBroadcast({ ok: false, message: 'something nobody has seen' }, fresh);
  assert.equal(decision.next, 'funding_indeterminate');
});

test('nonce too low means opposite things on a first send and a replay', () => {
  // First send: we built against a stale count and were refused, so nothing moved.
  assert.equal(
    classifyBroadcast({ ok: false, message: 'nonce too low' }, fresh).next,
    'funding_failed'
  );
  // Replay: the nonce may have been consumed by our own transaction mining.
  // Only the receipt can tell, so it goes to the reconciler.
  assert.equal(
    classifyBroadcast({ ok: false, message: 'nonce too low' }, replay).next,
    'funding_indeterminate'
  );
});

test('classification is case-insensitive', () => {
  // Node error strings are not a stable interface; casing varies by client.
  assert.equal(
    classifyBroadcast({ ok: false, message: 'INSUFFICIENT FUNDS' }, fresh).next,
    'funding_failed'
  );
  assert.equal(
    classifyBroadcast({ ok: false, message: 'Already Known' }, replay).next,
    'funding'
  );
});

test('every decision carries a reason an operator can read', () => {
  const cases: { ok: false; message: string }[] = [
    { ok: false, message: 'insufficient funds' },
    { ok: false, message: 'already known' },
    { ok: false, message: 'nonce too low' },
    { ok: false, message: 'socket hang up' },
  ];
  for (const c of cases) {
    for (const opts of [fresh, replay]) {
      assert.ok(classifyBroadcast(c, opts).reason.length > 20, c.message);
    }
  }
  assert.ok(classifyBroadcast({ ok: true }, fresh).reason.length > 0);
});

test('a receipt settles it either way', () => {
  assert.equal(classifyConfirmation('success').next, 'funded');
  assert.equal(classifyConfirmation('reverted').next, 'funding_failed');
  assert.equal(classifyConfirmation('missing').next, 'funding_indeterminate');
});

test('a missing receipt never concludes anything', () => {
  // It is the absence of evidence, which is exactly why the frozen state exists.
  const decision = classifyConfirmation('missing');
  assert.notEqual(decision.next, 'funded');
  assert.notEqual(decision.next, 'funding_failed');
});
