import 'server-only';
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { getPublicClient, sendCall, isAddress, type TransferOutcome } from '../chain';
import { isNative, type TokenInfo } from '../tokens';
import { quoteExactInput, isQuoteReliable, type PoolState, type Quote } from './quote';

/**
 * Swapping on Robinhood Chain, via Uniswap V3.
 *
 * Every address below was found by reading the chain, not by copying a
 * deployment doc — and that mattered: the canonical Uniswap addresses used on
 * most networks are *not* the ones here. The factory was read off the live
 * NVDA/USDG pool's own `factory()`, and the router was identified from the
 * `sender` of real Swap events, then confirmed three ways: its `factory()`
 * matches the pool's, its `WETH9()` matches the WETH in our token registry, and
 * its bytecode carries the SwapRouter02 selectors.
 *
 * This is a spend path that needs no licence: the user initiates a trade from
 * their own custodial balance. It is deliberately dashboard-only and never
 * reachable from the bot — auto-selling someone's holdings because they tweeted
 * a word is a trade they did not authorise.
 */

/** Uniswap V3 factory. Read from the live pool's `factory()`. */
export const V3_FACTORY: Address = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';

/**
 * SwapRouter02. Identified from live Swap event senders and confirmed against
 * the factory and WETH9 above.
 */
export const SWAP_ROUTER: Address = '0xcaf681a66d020601342297493863e78c959e5cb2';

/** Fee tiers to search, cheapest first. 500 = 0.05%. */
const FEE_TIERS = [100, 500, 3000, 10000] as const;

const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
]);

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
]);

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
]);

const APPROVE_GAS = 80_000n;
const SWAP_GAS = 400_000n;

export interface ResolvedPool {
  address: Address;
  fee: number;
  /** True when the token being sold is the pool's token0. */
  zeroForOne: boolean;
  state: PoolState;
}

/**
 * Find the deepest pool for a pair and read everything a quote needs.
 *
 * Picks by the balance of the token being sold rather than by fee tier, because
 * a cheap tier with no depth is worse than an expensive one with plenty.
 */
export async function resolvePool(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo
): Promise<ResolvedPool | null> {
  if (isNative(tokenIn) || isNative(tokenOut)) {
    // Native ETH has to be wrapped first. Out of scope for now, and returning
    // null makes the caller say so rather than silently swapping the wrong thing.
    return null;
  }
  const a = tokenIn.address!;
  const b = tokenOut.address!;
  const client = getPublicClient();

  const candidates = await Promise.all(
    FEE_TIERS.map(async (fee) => {
      try {
        const pool = (await client.readContract({
          address: V3_FACTORY,
          abi: FACTORY_ABI,
          functionName: 'getPool',
          args: [a, b, fee],
        })) as Address;
        if (!isAddress(pool) || /^0x0+$/.test(pool)) return null;

        const [slot0, token0, poolFee, bal0, bal1] = await Promise.all([
          client.readContract({ address: pool, abi: POOL_ABI, functionName: 'slot0' }),
          client.readContract({ address: pool, abi: POOL_ABI, functionName: 'token0' }),
          client.readContract({ address: pool, abi: POOL_ABI, functionName: 'fee' }),
          client.readContract({
            address: a,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [pool],
          }),
          client.readContract({
            address: b,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [pool],
          }),
        ]);

        const zeroForOne = (token0 as string).toLowerCase() === a.toLowerCase();
        const sqrtPriceX96 = (slot0 as readonly unknown[])[0] as bigint;
        if (sqrtPriceX96 <= 0n) return null;

        return {
          address: pool,
          fee: Number(poolFee),
          zeroForOne,
          // token0/token1 ordering is the pool's, not the caller's.
          state: {
            sqrtPriceX96,
            token0Balance: zeroForOne ? (bal0 as bigint) : (bal1 as bigint),
            token1Balance: zeroForOne ? (bal1 as bigint) : (bal0 as bigint),
            feePips: Number(poolFee),
            token0Decimals: zeroForOne ? tokenIn.decimals : tokenOut.decimals,
            token1Decimals: zeroForOne ? tokenOut.decimals : tokenIn.decimals,
          } satisfies PoolState,
          inputDepth: zeroForOne ? (bal0 as bigint) : (bal1 as bigint),
        };
      } catch {
        return null;
      }
    })
  );

  const live = candidates.filter((c): c is NonNullable<typeof c> => c !== null);
  if (live.length === 0) return null;

  live.sort((x, y) => (y.inputDepth > x.inputDepth ? 1 : y.inputDepth < x.inputDepth ? -1 : 0));
  const best = live[0]!;
  return { address: best.address, fee: best.fee, zeroForOne: best.zeroForOne, state: best.state };
}

export interface SwapQuoteResult {
  pool: ResolvedPool;
  quote: Quote;
  reliable: boolean;
}

export async function quoteSwap(params: {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: bigint;
  slippageBps: number;
}): Promise<SwapQuoteResult | null> {
  const pool = await resolvePool(params.tokenIn, params.tokenOut);
  if (!pool) return null;

  const quote = quoteExactInput({
    state: pool.state,
    amountIn: params.amountIn,
    zeroForOne: pool.zeroForOne,
    slippageBps: params.slippageBps,
  });

  return { pool, quote, reliable: isQuoteReliable(quote) };
}

export type SwapOutcome =
  | { step: 'approve'; outcome: TransferOutcome }
  | { step: 'swap'; outcome: TransferOutcome };

/**
 * Execute the swap: approve the router if needed, then `exactInputSingle`.
 *
 * Returns the step that ended it, so a caller can tell "the approval failed and
 * nothing moved" from "the approval landed and the swap did not" — which are
 * very different things to tell a user.
 */
export async function executeSwap(params: {
  privateKey: Hex;
  owner: Address;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  pool: ResolvedPool;
  quote: Quote;
  deadlineSeconds?: number;
}): Promise<SwapOutcome> {
  const tokenIn = params.tokenIn.address!;
  const client = getPublicClient();

  const allowance = (await client.readContract({
    address: tokenIn,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [params.owner, SWAP_ROUTER],
  })) as bigint;

  if (allowance < params.quote.amountIn) {
    // Approve exactly what this swap needs, not an unlimited allowance. An
    // infinite approval on a custodial wallet means a router bug drains every
    // user at once; re-approving costs one cheap transaction.
    const approveOutcome = await sendCall({
      privateKey: params.privateKey,
      to: tokenIn,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [SWAP_ROUTER, params.quote.amountIn],
      }),
      gas: APPROVE_GAS,
    });
    if (approveOutcome.status !== 'confirmed') {
      return { step: 'approve', outcome: approveOutcome };
    }
  }

  const swapOutcome = await sendCall({
    privateKey: params.privateKey,
    to: SWAP_ROUTER,
    data: encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut: params.tokenOut.address!,
          fee: params.pool.fee,
          recipient: params.owner,
          amountIn: params.quote.amountIn,
          // The floor from the quote. This is the only thing standing between
          // the user and an adverse price move between quoting and inclusion.
          amountOutMinimum: params.quote.amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
    gas: SWAP_GAS,
  });

  return { step: 'swap', outcome: swapOutcome };
}
