import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  drawWinners,
  splitPrize,
  generateSeed,
  commitmentFor,
  verifyCommitment,
} from './draw.ts';

/**
 * The whole value of the giveaway feature is that these properties hold. If the
 * draw is not reproducible, or the split loses units, the "provably fair" claim
 * is false advertising.
 */

const entries = Array.from({ length: 100 }, (_, i) => `entry-${i}`);

/* ------------------------------------------------------------- commitment */

test('a commitment verifies against its seed and nothing else', () => {
  const seed = generateSeed();
  assert.ok(verifyCommitment(seed, commitmentFor(seed)));
  assert.ok(!verifyCommitment(generateSeed(), commitmentFor(seed)));
});

test('seeds are 32 bytes of hex', () => {
  assert.match(generateSeed(), /^[0-9a-f]{64}$/);
});

/* ------------------------------------------------------------------- draw */

test('the same inputs always produce the same winners', () => {
  // This is the property a sceptical entrant checks. If it fails, nothing else
  // about the feature matters.
  const a = drawWinners({ seed: 'abc123', beacon: 'BEACON', entries, winners: 10 });
  const b = drawWinners({ seed: 'abc123', beacon: 'BEACON', entries, winners: 10 });
  assert.deepEqual(a, b);
});

test('entry order does not change the outcome', () => {
  const forward = drawWinners({ seed: 'abc123', beacon: 'BEACON', entries, winners: 10 });
  const reversed = drawWinners({
    seed: 'abc123',
    beacon: 'BEACON',
    entries: [...entries].reverse(),
    winners: 10,
  });
  assert.deepEqual(forward, reversed);
});

test('a different beacon produces a different draw', () => {
  const a = drawWinners({ seed: 'abc123', beacon: 'BEACON-A', entries, winners: 10 });
  const b = drawWinners({ seed: 'abc123', beacon: 'BEACON-B', entries, winners: 10 });
  assert.notDeepEqual(a, b);
});

test('a different seed produces a different draw', () => {
  const a = drawWinners({ seed: 'seed-a', beacon: 'BEACON', entries, winners: 10 });
  const b = drawWinners({ seed: 'seed-b', beacon: 'BEACON', entries, winners: 10 });
  assert.notDeepEqual(a, b);
});

test('winners are distinct', () => {
  const winners = drawWinners({ seed: 'abc123', beacon: 'BEACON', entries, winners: 25 });
  assert.equal(new Set(winners).size, 25);
});

test('one person cannot win twice by replying twice', () => {
  const winners = drawWinners({
    seed: 'abc123',
    beacon: 'BEACON',
    entries: ['@alice', '@alice', '@alice', '@bob'],
    winners: 2,
  });
  assert.equal(new Set(winners).size, 2);
  assert.deepEqual([...winners].sort(), ['@alice', '@bob']);
});

test('asking for more winners than entrants pays everyone once', () => {
  const winners = drawWinners({
    seed: 'abc123',
    beacon: 'BEACON',
    entries: ['@a', '@b'],
    winners: 10,
  });
  assert.equal(winners.length, 2);
});

test('an empty pool draws nobody', () => {
  assert.deepEqual(drawWinners({ seed: 's', beacon: 'b', entries: [], winners: 5 }), []);
});

test('selection is not biased toward the front of the pool', () => {
  // Rejection sampling exists to prevent modulo bias. Draw one winner from a
  // 100-entry pool many times and check the picks spread across the range.
  const counts = new Map<string, number>();
  for (let i = 0; i < 3000; i++) {
    const [winner] = drawWinners({ seed: 'seed', beacon: `beacon-${i}`, entries, winners: 1 });
    counts.set(winner!, (counts.get(winner!) ?? 0) + 1);
  }
  // Every entry should come up at least once across 3000 single draws of 100.
  assert.ok(counts.size > 90, `only ${counts.size} distinct winners across 3000 draws`);

  const expected = 3000 / 100;
  const worst = Math.max(...[...counts.values()].map((c) => Math.abs(c - expected)));
  assert.ok(worst < expected, `one entry deviated by ${worst}, expected well under ${expected}`);
});

/* ------------------------------------------------------------------ split */

test('the split always sums to the full prize', () => {
  for (const [total, winners] of [
    [1_000_000_000n, 3],
    [5n, 10],
    [7n, 3],
    [123_456_789n, 7],
  ] as const) {
    const parts = splitPrize(total, winners);
    assert.equal(
      parts.reduce((a, b) => a + b, 0n),
      total,
      `${total} across ${winners} lost units`
    );
  }
});

test('the remainder is distributed, not dropped', () => {
  // 7 across 3 is 3,2,2 — never 2,2,2 with one unit stranded in the wallet.
  assert.deepEqual(splitPrize(7n, 3), [3n, 2n, 2n]);
});

test('an even split gives everyone the same', () => {
  assert.deepEqual(splitPrize(9n, 3), [3n, 3n, 3n]);
});

test('splitting between nobody returns nothing', () => {
  assert.deepEqual(splitPrize(100n, 0), []);
});
