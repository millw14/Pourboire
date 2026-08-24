import { NextRequest } from 'next/server';
import { PublicKey } from '@solana/web3.js';
import connectDB from '@/lib/mongodb';
import { requireCaller } from '@/lib/auth';
import { handleError, ok, rateLimit, tooManyRequests } from '@/lib/api';
import { resolveCallerUser } from '@/lib/wallets';
import { cluster } from '@/lib/env';
import { getConnection, lamportsToSol } from '@/lib/solana';
import { findTokenBySymbol, formatAmount } from '@/lib/tokens';
import type { ITransaction, IPendingClaim } from '@/models/User';

/**
 * Everything the dashboard needs, in one authenticated round trip.
 *
 * The dashboard used to bootstrap itself with three chained requests —
 * ensure-tip-account, then balance, then pending — each waiting on the last, and
 * each identifying the user by a handle taken from the request body. That was
 * both slow (three serial round trips before the first number appears) and the
 * reason any caller could read any user's history by guessing a wallet address.
 */

export const maxDuration = 20;

const HISTORY_LIMIT = 100;

/** Rebuild a token descriptor from what the record stored alongside the amount. */
function tokenOf(record: { tokenSymbol: string; tokenMint: string | null; tokenDecimals: number }) {
  return (
    findTokenBySymbol(record.tokenSymbol) ?? {
      symbol: record.tokenSymbol,
      name: record.tokenSymbol,
      mint: record.tokenMint,
      decimals: record.tokenDecimals,
      color: '#8B8B8B',
    }
  );
}

export async function GET(req: NextRequest) {
  try {
    const caller = await requireCaller(req);

    if (!rateLimit(`me:${caller.privyUserId}`, 60, 60_000)) {
      return tooManyRequests();
    }

    await connectDB();
    const user = await resolveCallerUser(caller);

    if (!user) {
      // Signed in, but with no linked X account — so we have no handle to hang a
      // tip wallet off. The UI uses this to prompt for linking rather than
      // showing an empty dashboard.
      return ok({
        needsTwitter: true,
        cluster: cluster(),
        user: null,
        wallet: null,
      });
    }

    // Balance is best-effort: an RPC hiccup should not blank the whole dashboard,
    // so it comes back as null and the UI says "unavailable" rather than "0 SOL".
    let balanceSol: number | null = null;
    let balanceError = false;
    if (user.walletAddress) {
      try {
        const lamports = await getConnection().getBalance(
          new PublicKey(user.walletAddress),
          'confirmed'
        );
        balanceSol = lamportsToSol(lamports);
      } catch {
        balanceError = true;
      }
    }

    const history = [...(user.history ?? [])]
      .sort((a: ITransaction, b: ITransaction) => +new Date(b.date) - +new Date(a.date))
      .slice(0, HISTORY_LIMIT)
      .map((h: ITransaction) => ({
        type: h.type,
        direction: h.direction ?? (h.type === 'transfer' ? 'out' : 'in'),
        // Amounts cross the wire as pre-formatted strings plus their raw base
        // units, so the client never has to know a token's decimals to render
        // them — and can never render them wrong.
        amount: formatAmount(BigInt(h.amount), tokenOf(h)),
        rawAmount: h.amount,
        token: h.tokenSymbol,
        counterparty: h.counterparty,
        txHash: h.txHash,
        status: h.status ?? 'confirmed',
        date: h.date,
      }));

    const pending = (user.pendingClaims ?? []).map((p: IPendingClaim) => ({
      id: String(p._id),
      amount: formatAmount(BigInt(p.amount), tokenOf(p)),
      token: p.tokenSymbol,
      sender: p.sender,
      tweetId: p.fromTx,
      createdAt: p.createdAt ?? user.createdAt,
    }));

    return ok({
      needsTwitter: false,
      cluster: cluster(),
      user: {
        handle: user.handle,
        name: user.name,
        profileImage: user.profileImage || caller.profileImage || '',
        bio: user.bio,
      },
      wallet: {
        address: user.walletAddress,
        balanceSol,
        balanceError,
      },
      pending,
      history,
      historyTruncated: (user.history?.length ?? 0) > HISTORY_LIMIT,
    });
  } catch (e) {
    return handleError('me', e);
  }
}
