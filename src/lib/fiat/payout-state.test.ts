import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_STATUSES,
  ACTIONABLE,
  TERMINAL,
  FROZEN,
  canTransition,
  isActionable,
  nextStatuses,
  STATUS_MESSAGES,
  type PayoutStatus,
} from './payout-state.ts';

/**
 * The tip path already shipped the bug these tests exist to prevent: a
 * partially-paid split was marked `pending`, the retry query selected it, and it
 * re-sent the whole total to someone already paid. The fix was a status the
 * query did not match.
 *
 * Here that is structural — `ACTIONABLE` is an allow-list — and these assertions
 * are what keep it structural as states are added.
 */

test('a worker can never act on a terminal or frozen payout', () => {
  // The invariant. Everything else in this file is a detail of it.
  for (const status of ALL_STATUSES) {
    if (TERMINAL.has(status) || FROZEN.has(status)) {
      assert.ok(!ACTIONABLE.has(status), `${status} is both untouchable and actionable`);
    }
  }
  assert.equal([...ACTIONABLE].filter((s) => TERMINAL.has(s)).length, 0);
  assert.equal([...ACTIONABLE].filter((s) => FROZEN.has(s)).length, 0);
});

test('the indeterminate states are frozen, not actionable', () => {
  // These are the two "we do not know whether money moved" states. Acting on
  // either is how it moves twice.
  assert.ok(FROZEN.has('funding_indeterminate'));
  assert.ok(FROZEN.has('submit_indeterminate'));
  assert.ok(!isActionable('funding_indeterminate'));
  assert.ok(!isActionable('submit_indeterminate'));
});

test('actionable is an allow-list, not the complement of terminal', () => {
  // If it were `!terminal`, the frozen states would be swept in — which is
  // exactly the mistake this encoding prevents.
  const complementOfTerminal = ALL_STATUSES.filter((s) => !TERMINAL.has(s));
  assert.notDeepEqual([...ACTIONABLE].sort(), complementOfTerminal.sort());
});

test('nothing transitions out of a terminal state', () => {
  for (const status of TERMINAL) {
    if (status === 'paid') continue; // paid -> reversed is the one exception
    assert.deepEqual(nextStatuses(status), [], `${status} should be terminal`);
  }
});

test('paid can only ever become reversed', () => {
  // Money coming back is real and has to be representable, but it is the single
  // move out of a settled payout.
  assert.deepEqual(nextStatuses('paid'), ['reversed']);
  assert.ok(canTransition('paid', 'reversed'));
  assert.ok(!canTransition('paid', 'failed'));
  assert.ok(!canTransition('paid', 'provider_pending'));
});

test('every state is reachable from quoted', () => {
  // An unreachable state is dead code that will be wrong when someone finally
  // routes to it.
  const seen = new Set<PayoutStatus>(['quoted']);
  const queue: PayoutStatus[] = ['quoted'];
  while (queue.length) {
    for (const next of nextStatuses(queue.shift()!)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  for (const status of ALL_STATUSES) {
    assert.ok(seen.has(status), `${status} is unreachable from quoted`);
  }
});

test('an indeterminate funding leg can only resolve on evidence', () => {
  // Not back to `funding` — that would mean signing again, which is the
  // double-send. Only forward, to a conclusion the reconciler can prove.
  assert.deepEqual([...nextStatuses('funding_indeterminate')].sort(), [
    'funded',
    'funding_failed',
  ]);
  assert.ok(!canTransition('funding_indeterminate', 'funding'));
});

test('an indeterminate submission may return to funded, and only there', () => {
  // `funded` means "submit again", and it is reachable only because the provider
  // can explicitly report it has no record of our idempotency key.
  assert.ok(canTransition('submit_indeterminate', 'funded'));
  assert.ok(!canTransition('submit_indeterminate', 'funding'));
  assert.ok(!canTransition('submit_indeterminate', 'quoted'));
});

test('funding cannot be re-entered from anywhere', () => {
  // Recovery from a failed funding leg is a NEW payout with a NEW quote. Reusing
  // the row is how a stale total gets re-sent.
  for (const status of ALL_STATUSES) {
    if (status === 'quoted') continue;
    assert.ok(!canTransition(status, 'funding'), `${status} must not re-enter funding`);
  }
});

test('every status has a message, and the dangerous ones say do not retry', () => {
  for (const status of ALL_STATUSES) {
    assert.ok(STATUS_MESSAGES[status]?.length > 0, `${status} has no message`);
  }
  for (const status of FROZEN) {
    assert.match(
      STATUS_MESSAGES[status],
      /do not try again/i,
      `${status} must tell the user not to retry`
    );
  }
});
