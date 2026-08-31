import { NextRequest } from 'next/server';
import connectDB from '@/lib/mongodb';
import { requireCaller } from '@/lib/auth';
import { check, handleError, ok, rateLimit, tooManyRequests, fail } from '@/lib/api';
import { resolveCallerUser } from '@/lib/wallets';
import { explorerTxUrl, isAddress } from '@/lib/chain';
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

    const result = await settleTransfer({
      sender: user,
      recipientAddress: destination,
      amount: parsed.base,
      token,
    });

    if (!result.ok) {
      return fail(400, result.message, 'insufficient_funds');
    }
    if (result.outcome.status === 'failed') {
      return fail(502, 'The network rejected the transfer. Nothing was sent.', 'tx_failed');
    }

    const amount = formatAmount(parsed.base, token.info);
    user.history.push({
      type: 'transfer',
      direction: 'out',
      amount: parsed.base.toString(),
      tokenSymbol: token.info.symbol,
      tokenMint: token.info.address,
      tokenDecimals: token.info.decimals,
      counterparty: destination,
      txHash: result.outcome.hash,
      status: result.outcome.status,
      date: new Date(),
    });
    await user.save();

    if (result.outcome.status === 'unconfirmed') {
      // Broadcast but not yet seen in a block. Reporting failure here is what
      // made callers retry and send twice, so this is deliberately a success
      // shape with an honest status.
      return ok({
        status: 'unconfirmed',
        txHash: result.outcome.hash,
        explorerUrl: explorerTxUrl(result.outcome.hash),
        message:
          'Sent, but not confirmed yet. Track it on the explorer — do not send again.',
      });
    }

    return ok({
      status: 'confirmed',
      txHash: result.outcome.hash,
      explorerUrl: explorerTxUrl(result.outcome.hash),
      amount,
      to: destination,
    });
  } catch (e) {
    return handleError('wallet/withdraw', e);
  }
}
