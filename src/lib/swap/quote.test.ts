import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  priceToken1PerToken0,
  quoteExactInput,
  isQuoteReliable,
  SwapQuoteError,
  inputBalanceOf,
  bindToAcceptedFloor,
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

/* --------------------------------------------------- pool selection depth */

test('the input balance is the pool side being sold, in both directions', () => {
  // Pool selection used to compute this separately and applied the caller's
  // token ordering a second time, so selling the pool's token1 ranked pools by
  // the depth of the token being BOUGHT. With NVDA/USDG that meant a shallow
  // NVDA pool holding lots of USDG could outrank the deep one.
  assert.equal(inputBalanceOf(NVDA_USDG, true), NVDA_USDG.token0Balance);
  assert.equal(inputBalanceOf(NVDA_USDG, false), NVDA_USDG.token1Balance);
});

test('pool share is measured against the token being sold', () => {
  // Both sides are base units of the same token, so this is a real ratio. Using
  // the other side's balance would compare 6dp to 18dp and read as ~0 bps.
  const sellingUsdg = quoteExactInput({
    state: NVDA_USDG,
    amountIn: 46_696_984_330n, // exactly 1% of the pool's USDG
    zeroForOne: true,
    slippageBps: 50,
  });
  assert.equal(sellingUsdg.poolShareBps, 100);

  const sellingNvda = quoteExactInput({
    state: NVDA_USDG,
    amountIn: 62_968_930_000_000_000_000n, // exactly 1% of the pool's NVDA
    zeroForOne: false,
    slippageBps: 50,
  });
  assert.equal(sellingNvda.poolShareBps, 100);
});

/* ----------------------------------------------- the floor is never zero */

test('a trade too small to carry a floor is refused, not sent unguarded', () => {
  // amountOutMinimum is the only on-chain protection a swap has. When slippage
  // rounds it to zero the router would accept any output at all, including one
  // wei — so this must refuse rather than execute.
  assert.throws(
    () =>
      quoteExactInput({
        state: { ...NVDA_USDG, token1Decimals: 6 },
        amountIn: 1n,
        zeroForOne: false,
        slippageBps: 5_000,
      }),
    SwapQuoteError
  );
});

/* ------------------------------------------- binding the approved price */

test('a better price than the one approved goes straight through', () => {
  const decision = bindToAcceptedFloor(100n, 120n);
  assert.ok(decision.ok);
  // The higher floor is used, not the accepted one — there is no reason to give
  // someone less protection than the market is currently offering.
  assert.equal(decision.floor, 120n);
});

test('exactly the approved price is accepted', () => {
  const decision = bindToAcceptedFloor(100n, 100n);
  assert.ok(decision.ok);
  assert.equal(decision.floor, 100n);
});

test('a worse price is refused, with the shortfall measured', () => {
  // This is the window that actually matters: between the number the person read
  // and the number the transaction carries. Without it, amountOutMinimum only
  // guards the milliseconds between the server's own quote and inclusion.
  const decision = bindToAcceptedFloor(100n, 90n);
  assert.ok(!decision.ok);
  assert.equal(decision.shortfallBps, 1_000); // 10%
});

test('a one-unit shortfall is still a refusal', () => {
  // No tolerance band. The user approved a number; anything below it is a
  // different trade, and they should get to look at it.
  const decision = bindToAcceptedFloor(1_000_000n, 999_999n);
  assert.ok(!decision.ok);
});

test('an API caller that never previewed is not blocked', () => {
  // Nothing was approved, so there is nothing to hold the quote to. The slippage
  // limit is still enforced by the quote itself.
  const decision = bindToAcceptedFloor(null, 90n);
  assert.ok(decision.ok);
  assert.equal(decision.floor, 90n);
});

test('a zero or negative accepted floor cannot be used to disable the check', () => {
  // Passing 0 must not read as "I accept anything" in a way that is different
  // from not passing it at all.
  const zero = bindToAcceptedFloor(0n, 5n);
  assert.ok(zero.ok);
  assert.equal(zero.floor, 5n);
});
