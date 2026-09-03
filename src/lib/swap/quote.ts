/**
 * Swap arithmetic. Pure, so it is testable — every decision that can cost
 * someone money lives here rather than in the module that talks to the chain.
 *
 * The danger in this file is decimals. USDG is 6 and every tokenised equity is
 * 18, so a Uniswap price — which is expressed in raw base units of token1 per
 * raw base unit of token0 — is out by a factor of 10^12 from the human price
 * until it is scaled. Getting that backwards would quote someone a trillion
 * times the right number.
 *
 * All arithmetic is bigint. `sqrtPriceX96` is a 160-bit fixed-point value;
 * squaring it overflows a double long before the result is meaningful.
 */

const Q96 = 2n ** 96n;

/** Fixed-point scale for intermediate prices. 18 dp is plenty and keeps it exact. */
export const PRICE_SCALE = 10n ** 18n;

/** Uniswap fees are in hundredths of a basis point: 500 = 0.05%. */
const FEE_DENOMINATOR = 1_000_000n;

export interface PoolState {
  sqrtPriceX96: bigint;
  /**
   * The pool's actual token balances, used only to size a trade against it.
   *
   * Deliberately not V3's `liquidity`: that is a sqrt-space quantity, not a
   * token amount, and comparing base units to it is a units error that produces
   * a plausible-looking number. The first version of this file did exactly that
   * and reported every trade — up to ten million dollars — as 0 bps of the pool.
   */
  token0Balance: bigint;
  token1Balance: bigint;
  /** Hundredths of a bip, straight from the pool's `fee()`. */
  feePips: number;
  token0Decimals: number;
  token1Decimals: number;
}

/**
 * Price of one whole token0 expressed in whole token1, scaled by PRICE_SCALE.
 *
 * `(sqrtPriceX96 / 2^96)^2` is the raw ratio; the decimal shift converts it to
 * something a human would recognise.
 */
export function priceToken1PerToken0(state: PoolState): bigint {
  const { sqrtPriceX96, token0Decimals, token1Decimals } = state;
  const rawScaled = (sqrtPriceX96 * sqrtPriceX96 * PRICE_SCALE) / (Q96 * Q96);
  return (rawScaled * 10n ** BigInt(token0Decimals)) / 10n ** BigInt(token1Decimals);
}

export interface QuoteInput {
  state: PoolState;
  /** Base units of the token being sold. */
  amountIn: bigint;
  /** True when selling token0 for token1. */
  zeroForOne: boolean;
  /** Tolerance in basis points. 50 = 0.5%. */
  slippageBps: number;
}

export interface Quote {
  amountIn: bigint;
  /** Estimated output at the current price, after the pool fee. */
  amountOut: bigint;
  /**
   * The floor the swap is executed with. This — not `amountOut` — is what the
   * user is actually guaranteed, because the price can move between quoting and
   * inclusion.
   */
  amountOutMinimum: bigint;
  feePips: number;
  slippageBps: number;
  /**
   * Rough share of the pool's liquidity this trade represents, in basis points.
   * A spot quote ignores tick crossing, so it *overestimates* output for large
   * trades; this is the signal that the estimate is getting unreliable.
   */
  poolShareBps: number;
}

export class SwapQuoteError extends Error {}

/**
 * Quote an exact-input swap from the pool's current price.
 *
 * Deliberately a spot quote rather than a full tick-crossing simulation. For the
 * amounts this feature serves — someone spending a tip — the difference is
 * negligible, and `amountOutMinimum` is what actually protects them either way.
 * `poolShareBps` is returned so a caller can refuse when that assumption stops
 * holding, rather than silently quoting a number that drifts.
 */
export function quoteExactInput(input: QuoteInput): Quote {
  const { state, amountIn, zeroForOne, slippageBps } = input;

  if (amountIn <= 0n) throw new SwapQuoteError('Enter an amount greater than zero');
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 5_000) {
    throw new SwapQuoteError('Slippage tolerance must be between 0.01% and 50%');
  }
  const inputBalance = zeroForOne ? state.token0Balance : state.token1Balance;
  if (inputBalance <= 0n) throw new SwapQuoteError('That pool has no liquidity');
  if (state.sqrtPriceX96 <= 0n) throw new SwapQuoteError('That pool has no price');

  // The pool takes its fee off the input before the swap.
  const feeAdjustedIn = (amountIn * (FEE_DENOMINATOR - BigInt(state.feePips))) / FEE_DENOMINATOR;

  const price = priceToken1PerToken0(state);
  if (price <= 0n) throw new SwapQuoteError('That pool has no usable price');

  // Selling token0 multiplies by the price; selling token1 divides by it. The
  // decimal shift is the inverse in each direction.
  const amountOut = zeroForOne
    ? (feeAdjustedIn * price * 10n ** BigInt(state.token1Decimals)) /
      (PRICE_SCALE * 10n ** BigInt(state.token0Decimals))
    : (feeAdjustedIn * PRICE_SCALE * 10n ** BigInt(state.token0Decimals)) /
      (price * 10n ** BigInt(state.token1Decimals));

  if (amountOut <= 0n) {
    throw new SwapQuoteError('That amount is too small to swap — it rounds to nothing');
  }

  const amountOutMinimum = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;

  return {
    amountIn,
    amountOut,
    amountOutMinimum,
    feePips: state.feePips,
    slippageBps,
    poolShareBps: poolShareBps(amountIn, inputBalance),
  };
}

/**
 * How big this trade is against what the pool actually holds of the token being
 * sold, in basis points. Both sides are base units of the same token, so this
 * is a real ratio rather than an indicator.
 */
function poolShareBps(amountIn: bigint, inputBalance: bigint): number {
  if (inputBalance <= 0n) return 10_000;
  const bps = (amountIn * 10_000n) / inputBalance;
  return bps > 10_000n ? 10_000 : Number(bps);
}

/** Above this, a spot quote is no longer trustworthy and the caller should refuse. */
export const MAX_POOL_SHARE_BPS = 100; // 1%

export function isQuoteReliable(quote: Quote): boolean {
  return quote.poolShareBps <= MAX_POOL_SHARE_BPS;
}
