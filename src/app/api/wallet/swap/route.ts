import { NextRequest } from 'next/server';
import { Keypair } from '@solana/web3.js';
import connectDB from '@/lib/mongodb';
import { requireCaller } from '@/lib/auth';
import { check, fail, handleError, ok, rateLimit, tooManyRequests } from '@/lib/api';
import { decryptPrivateKey } from '@/lib/crypto';
import { resolveCallerUser } from '@/lib/wallets';
import { executeSwap, getQuote } from '@/lib/jupiter';
import { parseTokenAmount, resolveToken } from '@/lib/settle';
import { explorerTxUrl } from '@/lib/solana';
import { formatAmount } from '@/lib/tokens';

/**
 * Swap one token for another inside the caller's own tip wallet.
 *
 * Two-step by design: `GET` returns a quote the person can look at, `POST`
 * executes a quote they have already seen. Executing a freshly-fetched quote
 * inside the POST would mean approving one price and receiving another.
 */

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    const caller = await requireCaller(req);
    if (!rateLimit(`quote:${caller.privyUserId}`, 30, 60_000)) return tooManyRequests();

    const { searchParams } = req.nextUrl;
    const fromSymbol = searchParams.get('from');
    const toSymbol = searchParams.get('to');
    const amount = searchParams.get('amount');
    check(fromSymbol && toSymbol && amount, 'Pick two tokens and an amount');
    check(fromSymbol !== toSymbol, 'Those are the same token');

    const from = await resolveToken(fromSymbol!);
    const to = await resolveToken(toSymbol!);

    const parsed = parseTokenAmount(amount!, from);
    if (!parsed.ok) return fail(400, parsed.message, 'invalid_request');

    const quote = await getQuote({
      inputMint: from.info.mint,
      outputMint: to.info.mint,
      amount: parsed.base,
      slippageBps: Number(searchParams.get('slippageBps') ?? 100),
    });

    return ok({
      quote,
      display: {
        pay: formatAmount(BigInt(quote.inAmount), from.info),
        receive: formatAmount(BigInt(quote.outAmount), to.info),
        minimumReceived: formatAmount(BigInt(quote.otherAmountThreshold), to.info),
        priceImpactPct: quote.priceImpactPct,
      },
    });
  } catch (e) {
    return handleError('wallet/swap:quote', e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const caller = await requireCaller(req);
    if (!rateLimit(`swap:${caller.privyUserId}`, 5, 60_000)) return tooManyRequests();

    await connectDB();
    const user = await resolveCallerUser(caller);
    check(user, 'No tip wallet found for your account');
    check(user.encryptedPrivateKey, 'Your tip wallet is not set up yet');

    const body = await req.json().catch(() => ({}));
    check(body?.quote?.raw, 'Get a quote first');

    const secretKey = await decryptPrivateKey(user.encryptedPrivateKey!);
    const keypair = Keypair.fromSecretKey(secretKey);
    check(
      keypair.publicKey.toString() === user.walletAddress,
      'Your tip wallet key does not match its address'
    );

    const outcome = await executeSwap({ quote: body.quote, signer: keypair });

    if (outcome.status === 'failed') {
      return fail(502, 'The swap did not go through. Nothing was exchanged.', 'tx_failed');
    }

    return ok({
      status: outcome.status,
      txHash: outcome.signature,
      explorerUrl: explorerTxUrl(outcome.signature),
      message:
        outcome.status === 'unconfirmed'
          ? 'Submitted, but not confirmed yet. Track it on Solscan — do not swap again.'
          : undefined,
    });
  } catch (e) {
    return handleError('wallet/swap', e);
  }
}
