import { NextRequest } from 'next/server';
import { Keypair } from '@solana/web3.js';
import connectDB from '@/lib/mongodb';
import { requireCaller } from '@/lib/auth';
import { check, handleError, ok, rateLimit, tooManyRequests, fail } from '@/lib/api';
import { decryptPrivateKey } from '@/lib/crypto';
import { resolveCallerUser } from '@/lib/wallets';
import { SOL } from '@/lib/tokens';
import {
  explorerTxUrl,
  getConnection,
  lamportsToSol,
  parseAmountSol,
  parsePublicKey,
  solToLamports,
  spendableLamports,
  transferLamports,
} from '@/lib/solana';

/**
 * Move SOL out of the caller's own custodial tip wallet.
 *
 * This endpoint previously took the account to debit from the request body and
 * had no authentication whatsoever, so anyone could drain anyone. The account is
 * now derived entirely from the verified session — the body carries only a
 * destination and an amount, and cannot select a victim.
 */

// The confirmation wait can legitimately take ~30s; make the platform budget explicit.
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
    const destination = parsePublicKey(body.toAddress, 'address');
    const amountSol = parseAmountSol(body.amount);
    const requested = solToLamports(amountSol);

    const secretKey = await decryptPrivateKey(user.encryptedPrivateKey!);
    check(secretKey.length === 64, 'Your tip wallet key could not be read');
    const keypair = Keypair.fromSecretKey(secretKey);

    check(
      keypair.publicKey.toString() === user.walletAddress,
      'Your tip wallet key does not match its address'
    );
    check(
      destination.toString() !== user.walletAddress,
      'That is your own tip wallet address'
    );

    const balance = await getConnection().getBalance(keypair.publicKey, 'confirmed');
    const spendable = spendableLamports(balance);
    if (requested > spendable) {
      // Report the real ceiling — the old message compared against the raw
      // balance, so "withdraw everything" built a transaction that could not
      // pay its own fee and failed on-chain.
      return fail(
        400,
        `You can withdraw up to ${lamportsToSol(spendable).toFixed(6)} SOL. The rest covers the network fee and keeps the account open.`,
        'insufficient_funds'
      );
    }

    const outcome = await transferLamports({
      from: keypair,
      to: destination,
      lamports: requested,
    });

    if (outcome.status === 'failed') {
      return fail(502, 'The network rejected the transfer. Nothing was sent.', 'tx_failed');
    }

    user.history.push({
      type: 'transfer',
      direction: 'out',
      // Base units, matching every other writer. Storing the human value here
      // would make the same field mean two different things depending on which
      // code path wrote it.
      amount: String(requested),
      tokenSymbol: SOL.symbol,
      tokenMint: SOL.mint,
      tokenDecimals: SOL.decimals,
      counterparty: destination.toString(),
      txHash: outcome.signature,
      status: outcome.status,
      date: new Date(),
    });
    await user.save();

    if (outcome.status === 'unconfirmed') {
      // Submitted but not observed. Reporting failure here is what made callers
      // retry and send twice, so this is deliberately a success shape with an
      // honest status.
      return ok({
        status: 'unconfirmed',
        txHash: outcome.signature,
        explorerUrl: explorerTxUrl(outcome.signature),
        message:
          'Sent, but the network has not confirmed it yet. Track it on Solscan — do not send again.',
      });
    }

    return ok({
      status: 'confirmed',
      txHash: outcome.signature,
      explorerUrl: explorerTxUrl(outcome.signature),
      amount: amountSol,
      to: destination.toString(),
    });
  } catch (e) {
    return handleError('wallet/withdraw', e);
  }
}
