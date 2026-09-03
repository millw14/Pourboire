/**
 * Exercise the real swap READ path against live Robinhood Chain mainnet.
 *
 * The approved plan promised a testnet proof: quote, approve, swap USDG into
 * NVDA, read the balance back. That proof cannot be performed. Chain 46630 hosts
 * none of it — not the tokens, not the Uniswap factory, not the router — and the
 * address registry is hardcoded to mainnet with no network-awareness to point
 * elsewhere. A "testnet run" would read zeros and prove nothing.
 *
 * So this proves what can honestly be proven without spending anyone's money:
 * the shipped `resolvePool` and `quoteSwap` run against the real factory, the
 * real pool and real balances, and their numbers are checked against the pool's
 * own reserves and against an independent recomputation.
 *
 * It never signs, never broadcasts, and never touches a private key. The write
 * path — approve and `exactInputSingle` — cannot be proven without a real
 * mainnet transaction. That is the user's money and the user's call.
 *
 * Run:
 *   node --experimental-strip-types --conditions=react-server scripts/verify-swap-live.ts
 *
 * `--conditions=react-server` resolves the `server-only` marker to its empty
 * variant, which is exactly what Next does for a server module.
 */

import { findTokenBySymbol, formatAmount } from '../src/lib/tokens.ts';
import { resolvePool, quoteSwap, V3_FACTORY, SWAP_ROUTER } from '../src/lib/swap/router.ts';
import { getPublicClient, activeChain } from '../src/lib/chain.ts';
import { priceToken1PerToken0, PRICE_SCALE, inputBalanceOf } from '../src/lib/swap/quote.ts';

process.env.NEXT_PUBLIC_CHAIN_NETWORK = 'mainnet';

const BALANCE_OF = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

let failures = 0;

function check(label: string, condition: unknown, detail = '') {
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const client = getPublicClient();
  const chain = activeChain();

  console.log(`\nChain: ${chain.name} (${chain.id})`);
  const [chainId, block] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
  check('RPC reachable and on the expected chain', chainId === chain.id, `chainId ${chainId}`);
  console.log(`  block ${block}`);

  console.log('\nContracts the swap path depends on:');
  for (const [label, address] of [
    ['V3 factory', V3_FACTORY],
    ['SwapRouter02', SWAP_ROUTER],
  ] as const) {
    const code = await client.getBytecode({ address });
    check(`${label} has code`, Boolean(code && code !== '0x'), address);
  }

  const usdg = findTokenBySymbol('USDG')!;
  const nvda = findTokenBySymbol('NVDA')!;

  // Both directions, because pool selection and the decimal shift are
  // direction-dependent and only one of them was ever exercised by hand.
  for (const [tokenIn, tokenOut] of [
    [usdg, nvda],
    [nvda, usdg],
  ] as const) {
    console.log(`\n${tokenIn.symbol} -> ${tokenOut.symbol}:`);

    const pool = await resolvePool(tokenIn, tokenOut);
    if (!pool) {
      check('pool resolved', false);
      continue;
    }
    check('pool resolved', true, `${pool.address} fee ${pool.fee}`);

    // The fix under test: the depth used to rank pools must be the pool's
    // balance of the token being SOLD, in both directions. Compared loosely
    // because this is a live pool doing millions a day — the balance moves
    // between resolvePool's read and this one. Loose is still decisive: the two
    // sides differ by nine orders of magnitude in base units.
    const [inHeld, outHeld] = await Promise.all(
      [tokenIn, tokenOut].map((t) =>
        client.readContract({
          address: t.address as `0x${string}`,
          abi: BALANCE_OF,
          functionName: 'balanceOf',
          args: [pool.address],
        })
      )
    );
    const depth = inputBalanceOf(pool.state, pool.zeroForOne);
    const drift = Number(depth > inHeld ? depth - inHeld : inHeld - depth) / Number(inHeld);
    check(
      'ranking depth is the pool balance of the token being sold',
      drift < 0.01 && depth !== outHeld,
      `${formatAmount(depth, tokenIn)} in the pool, ${(drift * 100).toFixed(4)}% drift since the read`
    );

    const oneUnit = 10n ** BigInt(tokenIn.decimals);
    const amountIn = tokenIn.symbol === 'USDG' ? oneUnit * 100n : oneUnit;
    const result = await quoteSwap({ tokenIn, tokenOut, amountIn, slippageBps: 50 });
    if (!result) {
      check('quote produced', false);
      continue;
    }

    console.log(
      `  ${formatAmount(result.quote.amountIn, tokenIn)}` +
        ` -> about ${formatAmount(result.quote.amountOut, tokenOut)}` +
        ` (floor ${formatAmount(result.quote.amountOutMinimum, tokenOut)})`
    );

    check('quote is reliable at this size', result.reliable, `${result.quote.poolShareBps} bps of pool`);
    check('the floor is below the estimate', result.quote.amountOutMinimum < result.quote.amountOut);
    check('the floor is non-zero', result.quote.amountOutMinimum > 0n);

    // The decimals check that matters, derived from the quote itself — this is
    // the number a user is actually shown, and a 10^12 slip does not produce a
    // slightly wrong price, it produces one a trillion times off.
    //
    // Deliberately direction-agnostic. The first version of this branched on
    // zeroForOne, which was wrong: PoolState is always expressed in the POOL's
    // ordering, so priceToken1PerToken0 means the same thing whichever way the
    // user is trading. It read $0.00 on one leg while the quote beside it was
    // correct — the checker was broken, not the code under test.
    const inHuman = Number(result.quote.amountIn) / 10 ** tokenIn.decimals;
    const outHuman = Number(result.quote.amountOut) / 10 ** tokenOut.decimals;
    const usdgPerNvda = tokenIn.symbol === 'USDG' ? inHuman / outHuman : outHuman / inHuman;
    check(
      'implied NVDA price is in a plausible range',
      usdgPerNvda > 20 && usdgPerNvda < 2_000,
      `$${usdgPerNvda.toFixed(2)} per share`
    );

    // And cross-check it against the pool state it came from.
    const fromState = Number(PRICE_SCALE) / Number(priceToken1PerToken0(pool.state));
    check(
      'the quote agrees with the pool state it came from',
      Math.abs(fromState - usdgPerNvda) / usdgPerNvda < 0.01,
      `pool state says $${fromState.toFixed(2)}`
    );
  }

  console.log(
    failures === 0
      ? '\nAll live checks passed. Read path proven against real mainnet state; write path NOT exercised.\n'
      : `\n${failures} check(s) FAILED.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
