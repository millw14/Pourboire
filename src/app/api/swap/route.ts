import { NextRequest } from 'next/server';
import connectDB from '@/lib/mongodb';
import { requireCaller } from '@/lib/auth';
import { check, fail, handleError, ok, rateLimit, tooManyRequests } from '@/lib/api';
import { resolveCallerUser } from '@/lib/wallets';
import { decryptPrivateKey } from '@/lib/crypto';
import { explorerTxUrl, isAddress, nativeBalance, tokenBalance, estimateFeeWei } from '@/lib/chain';
import { findTokenBySymbol, formatAmount, toBaseUnits, type TokenInfo } from '@/lib/tokens';
import { executeSwap, quoteSwap } from '@/lib/swap/router';
import { SwapQuoteError } from '@/lib/swap/quote';
import type { Address, Hex } from 'viem';

/**
 * Swap one holding for another, on-chain.
 *
 * This is the spend path that needs no licensed partner: it is a trade the user
 * initiates from their own custodial balance, not a transfer of value into the
 * banking system. It is reachable only from the dashboard — never from a bot
 * command — because auto-selling someone's holdings in response to a tweet is a
 * trade they did not authorise.
 *
 * `POST` with `preview: true` quotes without moving anything. Without it, the
 * swap executes against the quote's `amountOutMinimum`.
 */

export const maxDuration = 60;

/** Default tolerance, and the ceiling a caller may ask for. */
const DEFAULT_SLIPPAGE_BPS = 50;
const MAX_SLIPPAGE_BPS = 500;

interface Parsed {
  from: TokenInfo;
  to: TokenInfo;
  amountIn: bigint;
  slippageBps: number;
}

function parseBody(body: Record<string, unknown>): Parsed {
  const from = findTokenBySymbol(String(body.from ?? ''));
  const to = findTokenBySymbol(String(body.to ?? ''));
  check(from, 'Pick a token to swap from');
  check(to, 'Pick a token to swap to');
  check(from.symbol !== to.symbol, 'Those are the same token');

  // Native ETH would need wrapping first; say so rather than half-supporting it.
  check(from.address !== null, 'ETH cannot be swapped directly yet — it pays gas');
  check(to.address !== null, 'ETH cannot be swapped directly yet — it pays gas');

  let amountIn: bigint;
  try {
    amountIn = toBaseUnits(String(body.amount ?? ''), from.decimals);
  } catch (e) {
    check(false, (e as Error).message);
    throw e; // unreachable; keeps the type narrow
  }
  check(amountIn > 0n, 'Enter an amount greater than zero');

  const requested = Number(body.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
  check(
    Number.isInteger(requested) && requested >= 1 && requested <= MAX_SLIPPAGE_BPS,
    `Slippage must be between 0.01% and ${MAX_SLIPPAGE_BPS / 100}%`
  );

  return { from, to, amountIn, slippageBps: requested };
}

export async function POST(req: NextRequest) {
  try {
    const caller = await requireCaller(req);
    const preview = Boolean((await req.clone().json().catch(() => ({}))).preview);

    // Quoting is cheap and read-only; executing moves money. Different budgets.
    if (!rateLimit(`swap:${caller.privyUserId}`, preview ? 60 : 5, 60_000)) {
      return tooManyRequests();
    }

    await connectDB();
    const user = await resolveCallerUser(caller);
    check(user, 'No tip wallet found for your account');
    check(user.encryptedPrivateKey, 'Your tip wallet is not set up yet');
    check(isAddress(user.walletAddress), 'Your tip wallet predates the chain move');

    const parsed = parseBody(await req.json().catch(() => ({})));
    const owner = user.walletAddress as Address;

    // Holding check before quoting, so "you do not have that much" is answered
    // before spending an RPC round trip on pool discovery.
    const held = await tokenBalance(parsed.from.address as Address, owner);
    if (held < parsed.amountIn) {
      return fail(
        400,
        `You only have ${formatAmount(held, parsed.from)}`,
        'insufficient_funds'
      );
    }

    let result;
    try {
      result = await quoteSwap({
        tokenIn: parsed.from,
        tokenOut: parsed.to,
        amountIn: parsed.amountIn,
        slippageBps: parsed.slippageBps,
      });
    } catch (e) {
      if (e instanceof SwapQuoteError) return fail(400, e.message, 'unquotable');
      throw e;
    }

    if (!result) {
      return fail(
        400,
        `There is no pool for ${parsed.from.symbol} to ${parsed.to.symbol} on this chain`,
        'no_pool'
      );
    }

    // A spot quote stops being trustworthy once the trade is a meaningful slice
    // of the pool, so refuse rather than quote a number that will not hold.
    if (!result.reliable) {
      return fail(
        400,
        'That trade is too large for this pool — the price would move against you. Try a smaller amount.',
        'trade_too_large'
      );
    }

    const quoted = {
      from: parsed.from.symbol,
      to: parsed.to.symbol,
      amountIn: formatAmount(result.quote.amountIn, parsed.from),
      // Both the estimate and the guaranteed floor, because they are different
      // promises and only one of them is binding.
      estimatedOut: formatAmount(result.quote.amountOut, parsed.to),
      minimumOut: formatAmount(result.quote.amountOutMinimum, parsed.to),
      slippageBps: result.quote.slippageBps,
      feePips: result.pool.fee,
      poolShareBps: result.quote.poolShareBps,
    };

    if (preview) {
      return ok({ quote: quoted });
    }

    // Gas is ETH regardless of which tokens move, and a swap is two transactions.
    const fee = await estimateFeeWei(true);
    const eth = await nativeBalance(owner);
    if (eth < fee * 2n) {
      return fail(
        400,
        'Not enough ETH to cover gas for the approval and the swap. Top up a little ETH and try again.',
        'insufficient_gas'
      );
    }

    const keyBytes = await decryptPrivateKey(user.encryptedPrivateKey!);
    check(keyBytes.length === 32, 'Your tip wallet key could not be read');
    const privateKey = `0x${Buffer.from(keyBytes).toString('hex')}` as Hex;

    const swap = await executeSwap({
      privateKey,
      owner,
      tokenIn: parsed.from,
      tokenOut: parsed.to,
      pool: result.pool,
      quote: result.quote,
    });

    const { step, outcome } = swap;

    if (outcome.status === 'rejected' || outcome.status === 'failed') {
      // Nothing moved, and we know it. A reverted swap usually means the price
      // moved past the floor, which is the guard working.
      return fail(
        502,
        step === 'approve'
          ? 'The approval did not go through. Nothing was swapped.'
          : 'The swap did not go through — the price moved past your limit. Nothing was swapped.',
        'swap_failed'
      );
    }

    if (outcome.status === 'unknown') {
      console.error('[swap] indeterminate submission', step, outcome.reason);
      return fail(
        502,
        'We lost contact with the network while sending. Check your balance before trying again — it may still have gone through.',
        'swap_indeterminate'
      );
    }

    if (step === 'approve') {
      // The approval is in flight but the swap never ran.
      return ok({
        status: 'pending_approval',
        txHash: outcome.hash,
        explorerUrl: explorerTxUrl(outcome.hash),
        message: 'The approval is still confirming. Try the swap again in a moment.',
      });
    }

    return ok({
      status: outcome.status,
      txHash: outcome.hash,
      explorerUrl: explorerTxUrl(outcome.hash),
      quote: quoted,
      message:
        outcome.status === 'unconfirmed'
          ? 'Sent, but not confirmed yet. Track it on the explorer — do not send again.'
          : undefined,
    });
  } catch (e) {
    return handleError('swap', e);
  }
}
