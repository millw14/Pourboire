import { NextRequest } from 'next/server';
import type { Address } from 'viem';
import connectDB from '@/lib/mongodb';
import { requireCaller } from '@/lib/auth';
import { check, handleError, ok, rateLimit, tooManyRequests, fail } from '@/lib/api';
import { resolveCallerUser } from '@/lib/wallets';
import { ERC20_GAS_LIMIT, explorerTxUrl, isAddress, requiredFeeWei, tokenBalance } from '@/lib/chain';
import { ensureGasFor } from '@/lib/gas/sponsor';
import { parseTokenAmount, resolveToken, settleTransfer } from '@/lib/settle';
import { formatAmount } from '@/lib/tokens';

/**
 * Move value out of the caller's own custodial tip wallet.
 *
 * This endpoint once took the account to debit from the request body and had no
 * authentication at all, so anyone could drain anyone. The account is now
 * derived entirely from the verified session — the body carries only a
 * destination, an amount and a token, and cannot select a victim.
 */

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const caller = await requireCaller(req);

    if (!rateLimit(`withdraw:${caller.privyUserId}`, 5, 60_000)) {
      return tooManyRequests();
    }

    await connectDB();
    const user = await resolveCallerUser(caller);
    check(user, 'No tip wallet found for your account');
    check(user.encryptedPrivateKey, 'Your tip wallet is not set up yet');

    const body = await req.json().catch(() => ({}));

    const destination = String(body.toAddress ?? '').trim();
    check(isAddress(destination), 'That is not a valid Robinhood Chain address');
    check(
      destination.toLowerCase() !== user.walletAddress?.toLowerCase(),
      'That is your own tip wallet address'
    );

    let token;
    try {
      token = await resolveToken(String(body.token ?? 'USDG'));
    } catch {
      return fail(400, "I don't recognise that token", 'unknown_token');
    }

    const parsed = parseTokenAmount(String(body.amount ?? ''), token);
    if (!parsed.ok) return fail(400, parsed.message, 'invalid_amount');

    // Cover the gas if they cannot. A tipped wallet holds the token and no ETH,
    // which is the state this whole feature exists for — and it is reachable
    // here only because the caller is a signed-in session, never a tweet.
    if (token.info.address !== null) {
      // Holdings FIRST. Sponsoring before checking that the wallet holds
      // anything made a grant obtainable without a transaction: ask to withdraw
      // a token you do not have, collect the ETH, let the request fail. One
      // request per identity, and the ETH stays. The swap route already checked
      // its holdings before sponsoring; this one did not.
      const held = await tokenBalance(token.info.address as Address, user.walletAddress as Address);
      if (held < parsed.base) {
        return fail(400, `You only have ${formatAmount(held, token.info)}`, 'insufficient_funds');
      }

      const gas = await ensureGasFor({
        user,
        intent: 'withdraw',
        requiredWei: await requiredFeeWei(ERC20_GAS_LIMIT),
        signedInAs: caller.privyUserId,
      });
      if (!gas.ok) {
        // Answer with the sponsorship refusal rather than letting settleTransfer
        // reply "top up a little ETH" — which is the wrong advice for a fee
        // spike (wait) and for a grant already in flight (wait), and gives the
        // client no way to tell a gas problem from a balance one.
        return fail(400, gas.message, 'insufficient_gas');
      }
    }

    const result = await settleTransfer({
      sender: user,
      recipientAddress: destination,
      amount: parsed.base,
      token,
    });

    if (!result.ok) {
      return fail(400, result.message, 'insufficient_funds');
    }

    const outcome = result.outcome;

    // Nothing left the wallet, and we know that for certain. Safe to say "try
    // again".
    if (outcome.status === 'failed' || outcome.status === 'rejected') {
      return fail(502, 'The network rejected the transfer. Nothing was sent.', 'tx_failed');
    }

    const amount = formatAmount(parsed.base, token.info);

    // `unknown` means the submission call itself failed in a way that does not
    // distinguish "never sent" from "sent, response lost". There is no hash to
    // record, but the money may be gone, so this must never read as a plain
    // error the user is invited to retry.
    if (outcome.status === 'unknown') {
      console.error('[wallet/withdraw] indeterminate submission', outcome.reason);
      return fail(
        502,
        'We lost contact with the network while sending. Check your balance before trying again — the transfer may still have gone through.',
        'tx_indeterminate'
      );
    }

    user.history.push({
      type: 'transfer',
      direction: 'out',
      amount: parsed.base.toString(),
      tokenSymbol: token.info.symbol,
      tokenMint: token.info.address,
      tokenDecimals: token.info.decimals,
      counterparty: destination,
      txHash: outcome.hash,
      status: outcome.status,
      date: new Date(),
    });
    await user.save();

    if (outcome.status === 'unconfirmed') {
      // Broadcast but not yet seen in a block. Reporting failure here is what
      // made callers retry and send twice, so this is deliberately a success
      // shape with an honest status.
      return ok({
        status: 'unconfirmed',
        txHash: outcome.hash,
        explorerUrl: explorerTxUrl(outcome.hash),
        message:
          'Sent, but not confirmed yet. Track it on the explorer — do not send again.',
      });
    }

    return ok({
      status: 'confirmed',
      txHash: outcome.hash,
      explorerUrl: explorerTxUrl(outcome.hash),
      amount,
      to: destination,
    });
  } catch (e) {
    return handleError('wallet/withdraw', e);
  }
}
