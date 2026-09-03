import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  priceToken1PerToken0,
  quoteExactInput,
  isQuoteReliable,
  SwapQuoteError,
  PRICE_SCALE,
  type PoolState,
} from './quote.ts';

/**
 * Swap arithmetic, pinned against the live NVDA/USDG pool.
 *
 * The fixture below is real state read off Robinhood Chain, not invented — pool
 * 0xd4eb2120…, token0 USDG (6dp), token1 NVDA (18dp), fee 500. At the time it
 * was read the implied share price was ~$225, which is what makes these
 * assertions meaningful: a decimals mistake here does not produce a slightly
 * wrong number, it produces one off by 10^12, and "is NVDA about $225 or about
 * $225 trillion" is a question the test can actually answer.
 */

const NVDA_USDG: PoolState = {
  sqrtPriceX96: 5279797881656263464854696266937741n,
  // Read off the same pool: 4,669,698.433 USDG and 6,296.893 NVDA.
  token0Balance: 4_669_698_433_000n,
  token1Balance: 6_296_893_000_000_000_000_000n,
  feePips: 500,
  token0Decimals: 6, // USDG
  token1Decimals: 18, // NVDA
};

const ONE_USDG = 1_000_000n; // 6 dp

test('derives a believable share price from real pool state', () => {
  // price = NVDA per 1 USDG. Inverted, that is the dollar price of one share.
  const nvdaPerUsdg = priceToken1PerToken0(NVDA_USDG);
  const usdgPerNvda = Number(PRICE_SCALE) / Number(nvdaPerUsdg);

  assert.ok(
    usdgPerNvda > 50 && usdgPerNvda < 1000,
    `implied share price ${usdgPerNvda} is not in a plausible range — check the decimal shift`
  );
});

test('a decimals slip would be caught, not rounded away', () => {
  // Same pool, but pretending both sides are 18dp — the mistake this file exists
  // to prevent. The price must move by exactly the 10^12 the shift corrects.
  const wrong = priceToken1PerToken0({ ...NVDA_USDG, token0Decimals: 18 });
  const right = priceToken1PerToken0(NVDA_USDG);
  assert.equal(wrong / right, 10n ** 12n);
});

test('quotes both directions consistently', () => {
  // Sell 1000 USDG for NVDA, then sell that NVDA back. Fees mean the round trip
  // loses value, but it must land in the right order of magnitude, not 10^12 out.
  const buy = quoteExactInput({
    state: NVDA_USDG,
    amountIn: 1000n * ONE_USDG,
    zeroForOne: true,
    slippageBps: 50,
  });
  assert.ok(buy.amountOut > 0n);

  const sellBack = quoteExactInput({
    state: NVDA_USDG,
    amountIn: buy.amountOut,
    zeroForOne: false,
    slippageBps: 50,
  });

  // Two 0.05% fees, so expect ~99.9% back. Allow a wide band; the point is that
  // it is near 1000 USDG rather than 10^-9 or 10^15 of it.
  const returned = Number(sellBack.amountOut) / Number(ONE_USDG);
  assert.ok(returned > 995 && returned < 1000, `round trip returned ${returned} USDG`);
});

test('the pool fee is taken off the input', () => {
  const withFee = quoteExactInput({
    state: NVDA_USDG,
    amountIn: 1000n * ONE_USDG,
    zeroForOne: true,
    slippageBps: 50,
  });
  const withoutFee = quoteExactInput({
    state: { ...NVDA_USDG, feePips: 0 },
    amountIn: 1000n * ONE_USDG,
    zeroForOne: true,
    slippageBps: 50,
  });
  assert.ok(withFee.amountOut < withoutFee.amountOut, 'fee was not applied');

  // 0.05% of the input, within rounding.
  const delta = Number(withoutFee.amountOut - withFee.amountOut) / Number(withoutFee.amountOut);
  assert.ok(delta > 0.0004 && delta < 0.0006, `fee came out as ${(delta * 100).toFixed(4)}%`);
});

test('amountOutMinimum is the guarantee, and it is always below the estimate', () => {
  const q = quoteExactInput({
    state: NVDA_USDG,
    amountIn: 100n * ONE_USDG,
    zeroForOne: true,
    slippageBps: 50,
  });
  assert.ok(q.amountOutMinimum < q.amountOut);
  // 0.5% below, exactly.
  assert.equal(q.amountOutMinimum, (q.amountOut * 9_950n) / 10_000n);
});

test('tighter slippage raises the floor', () => {
  const loose = quoteExactInput({ state: NVDA_USDG, amountIn: 100n * ONE_USDG, zeroForOne: true, slippageBps: 500 });
  const tight = quoteExactInput({ state: NVDA_USDG, amountIn: 100n * ONE_USDG, zeroForOne: true, slippageBps: 10 });
  assert.ok(tight.amountOutMinimum > loose.amountOutMinimum);
});

test('rejects nonsense inputs rather than quoting them', () => {
  const base = { state: NVDA_USDG, zeroForOne: true, slippageBps: 50 };
  assert.throws(() => quoteExactInput({ ...base, amountIn: 0n }), SwapQuoteError);
  assert.throws(() => quoteExactInput({ ...base, amountIn: -1n }), SwapQuoteError);
  assert.throws(
    () => quoteExactInput({ ...base, amountIn: ONE_USDG, slippageBps: 0 }),
    SwapQuoteError
  );
  assert.throws(
    () => quoteExactInput({ ...base, amountIn: ONE_USDG, slippageBps: 9_999 }),
    SwapQuoteError
  );
  assert.throws(
    () => quoteExactInput({ ...base, amountIn: ONE_USDG, state: { ...NVDA_USDG, token0Balance: 0n } }),
    SwapQuoteError
  );
});

test('an amount that rounds to nothing is refused, not silently zeroed', () => {
  // One base unit of NVDA is ~10^-18 of a share; it buys no measurable USDG.
  assert.throws(
    () => quoteExactInput({ state: NVDA_USDG, amountIn: 1n, zeroForOne: false, slippageBps: 50 }),
    SwapQuoteError
  );
});

test('flags a trade too large for a spot quote to be trusted', () => {
  const small = quoteExactInput({
    state: NVDA_USDG,
    amountIn: ONE_USDG,
    zeroForOne: true,
    slippageBps: 50,
  });
  assert.ok(isQuoteReliable(small), 'a 1 USDG trade should be reliable');

  const huge = quoteExactInput({
    state: NVDA_USDG,
    amountIn: 500_000n * ONE_USDG,
    zeroForOne: true,
    slippageBps: 50,
  });
  assert.ok(!isQuoteReliable(huge), 'a 500k USDG trade is >1% of the pool and should be refused');

  // And the measure is a real ratio now: 1% of the pool is ~46,700 USDG.
  const atThreshold = quoteExactInput({
    state: NVDA_USDG,
    amountIn: 46_696n * ONE_USDG,
    zeroForOne: true,
    slippageBps: 50,
  });
  assert.equal(atThreshold.poolShareBps, 99);
});

test('never returns a floating point number for an amount', () => {
  // The whole file is bigint for a reason; a Number sneaking in loses precision
  // above 2^53 and this is the cheapest way to notice.
  const q = quoteExactInput({
    state: NVDA_USDG,
    amountIn: 12_345_678n,
    zeroForOne: true,
    slippageBps: 50,
  });
  for (const v of [q.amountIn, q.amountOut, q.amountOutMinimum]) {
    assert.equal(typeof v, 'bigint');
  }
});
