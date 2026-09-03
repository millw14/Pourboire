import { NextRequest } from 'next/server';
import connectDB from '@/lib/mongodb';
import { requireCaller } from '@/lib/auth';
import { check, fail, handleError, ok, rateLimit, tooManyRequests } from '@/lib/api';
import { resolveCallerUser } from '@/lib/wallets';
import { decryptPrivateKey } from '@/lib/crypto';
import { explorerTxUrl, isAddress, nativeBalance, tokenBalance, estimateFeeWei } from '@/lib/chain';
import { findTokenBySymbol, formatAmount, toBaseUnits, type TokenInfo } from '@/lib/tokens';
import { executeSwap, quoteSwap, PoolLookupError } from '@/lib/swap/router';
import { SwapQuoteError, bindToAcceptedFloor } from '@/lib/swap/quote';
import { ensureGasFor } from '@/lib/gas/sponsor';
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

/**
 * Confirmation waits, budgeted to finish inside `maxDuration`.
 *
 * Three of them now — a gas grant, an approval, and the swap — and 8 + 8 + 16
 * = 32s is LESS than the 15 + 20 it replaces. The route gained a confirmation
 * and still finishes sooner than it did.
 *
 * The measured non-waiting work is around 5s at realistic RPC latency (pool
 * discovery alone is 24 eth_calls), so the remainder is margin for a cold start
 * or a degraded RPC — conditions that tend to arrive together. Being killed by
 * the platform mid-wait is worse than giving up early: an early return still
 * carries the transaction hash, while a 504 carries nothing and reads to the
 * client as an invitation to retry.
 */
const APPROVE_CONFIRM_MS = 8_000;
const SWAP_CONFIRM_MS = 16_000;

interface Parsed {
  from: TokenInfo;
  to: TokenInfo;
  amountIn: bigint;
  slippageBps: number;
  /**
   * The floor the user actually saw and approved, in base units of `to`.
   * Null when the caller never previewed.
   */
  acceptedMinimumOut: bigint | null;
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

  // Echoed back from the preview so the price the user approved can be held
  // against the one about to execute. A client that omits it gets no such
  // protection, which is why the dialog always sends it.
  let acceptedMinimumOut: bigint | null = null;
  const accepted = body.acceptedMinimumOut;
  if (accepted !== undefined && accepted !== null && String(accepted) !== '') {
    try {
      acceptedMinimumOut = BigInt(String(accepted));
    } catch {
      check(false, 'Could not read the quote you approved — re-open the swap');
    }
    check(acceptedMinimumOut === null || acceptedMinimumOut > 0n, 'That quote is no longer valid');
  }

  return { from, to, amountIn, slippageBps: requested, acceptedMinimumOut };
}

export async function POST(req: NextRequest) {
  try {
    const caller = await requireCaller(req);
    const preview = Boolean((await req.clone().json().catch(() => ({}))).preview);

    // Quoting is cheap and read-only; executing moves money. Different budgets.
    // Separate KEYS, not just separate limits. One shared counter meant six
    // previews — which the dialog fires on every keystroke — filled the execute
    // budget, and a user who had done nothing but type was told to slow down.
    const allowed = preview
      ? rateLimit(`swap:preview:${caller.privyUserId}`, 60, 60_000)
      : rateLimit(`swap:exec:${caller.privyUserId}`, 5, 60_000);
    if (!allowed) return tooManyRequests();

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
      if (e instanceof PoolLookupError) {
        // A network problem, not a fact about the pair. Retryable, and said so —
        // the alternative is quoting from whichever fee tiers happened to answer,
        // which can route a trade into a pool a hundred times shallower.
        return fail(
          503,
          'We could not read every pool for that pair just now. Try again in a moment.',
          'pool_lookup_failed'
        );
      }
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

    const describe = (floor: bigint) => ({
      from: parsed.from.symbol,
      to: parsed.to.symbol,
      amountIn: formatAmount(result.quote.amountIn, parsed.from),
      // Both the estimate and the guaranteed floor, because they are different
      // promises and only one of them is binding.
      estimatedOut: formatAmount(result.quote.amountOut, parsed.to),
      minimumOut: formatAmount(floor, parsed.to),
      // The same floor in base units, for the client to hand back on execute.
      // Formatted output is rounded for display and cannot be compared exactly.
      minimumOutBase: floor.toString(),
      slippageBps: result.quote.slippageBps,
      feePips: result.pool.fee,
      poolShareBps: result.quote.poolShareBps,
    });

    if (preview) {
      return ok({ quote: describe(result.quote.amountOutMinimum) });
    }

    // What the user approved becomes what the transaction carries. Refusal is
    // reserved for a price that can no longer deliver it at all — sending that
    // swap would revert on its own floor and burn gas proving it.
    const binding = bindToAcceptedFloor({
      accepted: parsed.acceptedMinimumOut,
      freshEstimate: result.quote.amountOut,
      freshFloor: result.quote.amountOutMinimum,
    });
    if (!binding.ok) {
      return fail(
        409,
        `The price moved ${(binding.shortfallBps / 100).toFixed(2)}% against you since you were quoted. Check the new price and try again.`,
        'price_moved'
      );
    }

    // Everything reported from here describes the floor actually being sent, not
    // the one the preview happened to compute.
    const quoted = describe(binding.floor);

    // Gas is ETH regardless of which tokens move, and a swap is two
    // transactions. Someone who was tipped USDG has no ETH at all — which is
    // exactly the person this path exists for — so cover the shortfall rather
    // than refuse. `ensureGasFor` returns ok having granted nothing when the
    // wallet can already pay, so the common case costs one balance read.
    const fee = await estimateFeeWei(true);
    const gas = await ensureGasFor({
      user,
      intent: 'swap',
      requiredWei: fee * 2n,
      signedInAs: caller.privyUserId,
    });
    if (!gas.ok) {
      return fail(400, gas.message, 'insufficient_gas');
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
      // The approved floor, not the freshly computed one. This is the only place
      // `binding.floor` can matter, and passing the fresh quote through unchanged
      // would quietly make the whole binding decorative.
      quote: { ...result.quote, amountOutMinimum: binding.floor },
      // Budgeted against `maxDuration` above. Two default 30s waits plus pool
      // discovery could overrun 60s, and being killed mid-wait loses the hash —
      // the platform then returns a bodyless 504 that the client reads as a
      // generic failure and offers to retry, for a swap already in flight.
      approveTimeoutMs: APPROVE_CONFIRM_MS,
      swapTimeoutMs: SWAP_CONFIRM_MS,
    });

    const { step, outcome } = swap;

    if (outcome.status === 'failed') {
      // It reached a block and reverted, so nothing moved and we know it. On the
      // swap step that usually means the price crossed the floor — the guard
      // working, not a fault.
      return fail(
        502,
        step === 'approve'
          ? 'The approval did not go through. Nothing was swapped.'
          : 'The swap did not go through — the price moved past your limit. Nothing was swapped.',
        'swap_failed'
      );
    }

    if (outcome.status === 'rejected') {
      // Refused before entering the mempool. Also nothing moved, but the causes
      // are different enough to be worth their own message.
      return fail(
        502,
        step === 'approve'
          ? 'The network refused the approval. Nothing was swapped.'
          : 'The network refused the swap. Nothing was swapped.',
        'swap_rejected'
      );
    }

    if (outcome.status === 'unknown') {
      // Deliberately a 200, not a 5xx. A 5xx is what makes clients retry, and a
      // retry is exactly what must not happen when the transaction may be live.
      // Same rule the payout route follows, for the same reason.
      console.error(
        '[swap] indeterminate submission',
        JSON.stringify({ step, owner, from: parsed.from.symbol, to: parsed.to.symbol, amount: quoted.amountIn, reason: outcome.reason })
      );
      return ok({
        status: 'indeterminate',
        step,
        retryable: false,
        message:
          step === 'approve'
            ? 'We lost contact with the network while approving. Nothing was swapped, but do not try again yet — check your recent activity on the explorer first.'
            : 'We lost contact with the network while sending your swap. Do not try again — it may have gone through. Check your recent activity on the explorer.',
      });
    }

    if (step === 'approve') {
      // The approval is in flight but the swap never ran.
      return ok({
        status: 'pending_approval',
        txHash: outcome.hash,
        explorerUrl: explorerTxUrl(outcome.hash),
        // The approve leg moves no money. Re-running signs a second approval at
        // the next nonce, which at worst wastes a little gas — so this one IS safe
        // to retry, and the flag now agrees with the sentence beside it.
        retryable: true,
        message: 'The approval is still confirming. Try the swap again in a moment.',
      });
    }

    return ok({
      status: outcome.status,
      txHash: outcome.hash,
      explorerUrl: explorerTxUrl(outcome.hash),
      // The quote that actually executed, not the one previewed. The dialog used
      // to report the preview's floor in the past tense — "at least X was
      // guaranteed" — which could name a number larger than what was received.
      quote: quoted,
      retryable: false,
      message:
        outcome.status === 'unconfirmed'
          ? 'Sent, but not confirmed yet. Track it on the explorer — do not send again.'
          : undefined,
    });
  } catch (e) {
    return handleError('swap', e);
  }
}
