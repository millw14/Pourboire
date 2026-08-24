import { NextRequest } from 'next/server';
import { Keypair, PublicKey } from '@solana/web3.js';
import connectDB from '@/lib/mongodb';
import { requireMachineCaller } from '@/lib/auth';
import { handleError, ok } from '@/lib/api';
import { decryptPrivateKey } from '@/lib/crypto';
import { searchMentions, postTweet } from '@/lib/twitter';
import { parseTipCommand, BOT_HANDLE } from '@/lib/tip-command';
import User from '@/models/User';
import ProcessedTweet from '@/models/ProcessedTweet';
import PollCursor, { MENTIONS_CURSOR } from '@/models/PollCursor';
import { ensureCustodialWallet, findUser } from '@/lib/wallets';
import {
  explorerTxUrl,
  getConnection,
  lamportsToSol,
  solToLamports,
  spendableLamports,
  transferLamports,
  RENT_EXEMPT_RESERVE,
} from '@/lib/solana';

/**
 * Read new @Pourboireonsol mentions and settle the tips in them.
 *
 * The two properties that matter here, both of which the previous version
 * lacked:
 *
 *  1. **It is not public.** It signs transfers out of user wallets, so it
 *     requires the CRON_SECRET and refuses to run at all if that is unset.
 *
 *  2. **Each tweet pays at most once, ever.** A tweet id is claimed in
 *     ProcessedTweet *before* any transfer is attempted. The unique index makes
 *     that claim atomic, so overlapping runs — or a caller hammering the
 *     endpoint — cannot double-send. The old version had no such record and
 *     re-read the same seven-day search window on every invocation.
 */

export const maxDuration = 300;

/** Leave room to finish the run and write results rather than being killed mid-transfer. */
const TIME_BUDGET_MS = 240_000;

/**
 * Vercel Cron issues GET requests with `Authorization: Bearer $CRON_SECRET`
 * attached automatically. POST is kept for manual runs and other schedulers.
 * Both go through the same guard.
 */
export async function GET(req: NextRequest) {
  return POST(req);
}

export async function POST(req: NextRequest) {
  try {
    requireMachineCaller(req);
    await connectDB();

    const startedAt = Date.now();

    // The cursor lives server-side; a caller cannot rewind it to replay old tips.
    const cursor = await PollCursor.findOneAndUpdate(
      { key: MENTIONS_CURSOR },
      { $setOnInsert: { key: MENTIONS_CURSOR } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const tweets = await searchMentions(`${BOT_HANDLE} -is:retweet`, cursor.sinceId);
    if (!tweets.length) {
      cursor.lastRunAt = new Date();
      await cursor.save();
      return ok({ processed: 0, skipped: 0, message: 'No new mentions' });
    }

    // Advance the cursor to the newest id we saw, regardless of per-tip outcome.
    // Tweet ids are snowflakes: numerically increasing, so max is the newest.
    let highWater = cursor.sinceId;
    for (const t of tweets) {
      if (!highWater || BigInt(t.id) > BigInt(highWater)) highWater = String(t.id);
    }

    let settled = 0;
    let skipped = 0;
    let deferred = 0;

    // Oldest first, so a partial run leaves a contiguous processed prefix.
    const ordered = [...tweets].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

    for (const tweet of ordered) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        // Stop cleanly and let the next run continue from the cursor rather than
        // being killed partway through a transfer.
        highWater = undefined;
        break;
      }

      const parsed = parseTipCommand(tweet.text ?? '');
      if (!parsed) continue;

      const senderHandle = tweet.author?.username ? `@${tweet.author.username.toLowerCase()}` : null;
      if (!senderHandle) {
        skipped++;
        continue;
      }

      // No explicit @recipient means "tip the author of the post I replied to" —
      // the flow the homepage teaches. Without a reply target there is nobody to
      // pay, so say so rather than failing silently.
      const recipientHandle =
        parsed.recipientHandle ??
        (tweet.replyToAuthor?.username ? `@${tweet.replyToAuthor.username.toLowerCase()}` : null);

      if (!recipientHandle || recipientHandle === senderHandle) {
        skipped++;
        continue;
      }

      // ---- Claim the tweet. First writer wins; everyone else skips. ----
      try {
        await ProcessedTweet.create({
          tweetId: String(tweet.id),
          status: 'claimed',
          senderHandle,
          recipientHandle,
          amount: parsed.amount,
          token: parsed.token,
        });
      } catch (e: unknown) {
        if ((e as { code?: number })?.code === 11000) {
          skipped++;
          continue;
        }
        throw e;
      }

      const result = await settleTip({
        tweetId: String(tweet.id),
        senderHandle,
        recipientHandle,
        amount: parsed.amount,
        token: parsed.token,
      });

      if (result === 'settled') settled++;
      else deferred++;
    }

    if (highWater) cursor.sinceId = highWater;
    cursor.lastRunAt = new Date();
    cursor.lastError = undefined;
    await cursor.save();

    // Tips that could not settle earlier — usually because the sender had not
    // funded their wallet yet — are retried here. This is what makes the pending
    // list resolve itself, so nobody has to press a "Claim" button that never
    // actually moved any money.
    const retried = await retryPending(startedAt);

    return ok({
      processed: settled + retried,
      deferred,
      skipped,
      scanned: tweets.length,
    });
  } catch (e) {
    return handleError('twitter/poll', e);
  }
}

/** How long a tip keeps being retried before we stop trying. */
const RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Re-attempt tips that parsed correctly but could not be paid at the time.
 *
 * Only `pending` and `failed` rows are eligible — never `unconfirmed`, because
 * an unconfirmed transfer may still land and retrying it would send the money
 * twice, which is precisely what this ledger exists to prevent.
 */
async function retryPending(startedAt: number): Promise<number> {
  const candidates = await ProcessedTweet.find({
    status: { $in: ['pending', 'failed'] },
    createdAt: { $gt: new Date(Date.now() - RETRY_WINDOW_MS) },
  })
    .sort({ createdAt: 1 })
    .limit(50);

  let settled = 0;
  for (const row of candidates) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    if (!row.senderHandle || !row.recipientHandle || !row.amount || !row.token) continue;

    const result = await settleTip(
      {
        tweetId: row.tweetId,
        senderHandle: row.senderHandle,
        recipientHandle: row.recipientHandle,
        amount: row.amount,
        token: row.token,
      },
      { quiet: true }
    );
    if (result === 'settled') settled++;
  }
  return settled;
}

type SettleResult = 'settled' | 'deferred';

async function settleTip(
  tip: {
    tweetId: string;
    senderHandle: string;
    recipientHandle: string;
    amount: number;
    token: 'SOL' | 'USDC';
  },
  opts: { quiet?: boolean } = {}
): Promise<SettleResult> {
  // On a retry we stay quiet about the same failure — otherwise every poll run
  // would post another 'please fund your wallet' reply under the same tweet.
  const notify = (text: string) => (opts.quiet ? Promise.resolve(null) : postTweet(text, tip.tweetId));
  const mark = (status: string, fields: Record<string, unknown> = {}) =>
    ProcessedTweet.updateOne({ tweetId: tip.tweetId }, { $set: { status, ...fields } });

  // USDC is parsed and acknowledged but there is no SPL transfer path yet.
  // The old code silently dropped these into the SOL branch, where the batch key
  // ignored the token and USDC amounts were summed into a *SOL* transfer.
  if (tip.token !== 'SOL') {
    await mark('pending', { note: 'USDC tips are not supported yet' });
    await notify(
      `${tip.senderHandle} USDC tips aren't supported yet — only SOL for now. Nothing was sent.`
    );
    return 'deferred';
  }

  const sender = await findUser({ handle: tip.senderHandle });
  if (!sender?.encryptedPrivateKey || !sender.walletAddress) {
    await mark('pending', { note: 'sender has no funded tip wallet' });
    await recordPendingClaim(tip);
    await notify(
      `@${tip.recipientHandle.replace(/^@/, '')} ${tip.senderHandle} wants to tip you ${tip.amount} SOL. They need to sign in at pourboire.tips and fund their tip wallet first.`
    );
    return 'deferred';
  }

  const { user: recipient } = await ensureCustodialWallet({ handle: tip.recipientHandle });

  const lamports = solToLamports(tip.amount);

  // A transfer that would leave the recipient's brand-new account below the
  // rent-exempt floor is rejected by the runtime — the old code sent it anyway
  // and burned a fee on every retry.
  if (lamports < RENT_EXEMPT_RESERVE) {
    await mark('pending', { note: 'below rent-exempt minimum' });
    await notify(
      `${tip.senderHandle} that tip is too small to land on-chain — the minimum is about ${lamportsToSol(RENT_EXEMPT_RESERVE).toFixed(5)} SOL. Nothing was sent.`
    );
    return 'deferred';
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(await decryptPrivateKey(sender.encryptedPrivateKey));
  } catch {
    await mark('failed', { note: 'sender key could not be decrypted' });
    return 'deferred';
  }

  const balance = await getConnection().getBalance(keypair.publicKey, 'confirmed');
  if (lamports > spendableLamports(balance)) {
    await mark('pending', { note: 'insufficient sender balance' });
    await recordPendingClaim(tip);
    await notify(
      `${tip.senderHandle} your tip wallet doesn't have enough SOL for that ${tip.amount} SOL tip. Top it up at pourboire.tips and mention me again.`
    );
    return 'deferred';
  }

  const outcome = await transferLamports({
    from: keypair,
    to: new PublicKey(recipient.walletAddress),
    lamports,
  });

  if (outcome.status === 'failed') {
    // Nothing landed, so it is safe to let this tweet be retried later.
    await mark('failed', { note: outcome.reason, txHash: outcome.signature });
    return 'deferred';
  }

  // `unconfirmed` stays claimed, never released — the transfer may still land and
  // releasing it would be exactly the double-send this ledger exists to prevent.
  await mark(outcome.status === 'confirmed' ? 'settled' : 'unconfirmed', {
    txHash: outcome.signature,
  });

  await User.updateOne(
    { _id: sender._id },
    {
      $push: {
        history: {
          type: 'transfer',
          direction: 'out',
          amount: tip.amount,
          token: 'SOL',
          counterparty: tip.recipientHandle,
          txHash: outcome.signature,
          status: outcome.status,
          date: new Date(),
        },
      },
    }
  );

  // $push/$pull rather than reassigning the whole array: the old code replaced
  // `recipient.pendingClaims` wholesale, so a claim added by a concurrent request
  // between read and save was silently discarded.
  await User.updateOne(
    { _id: recipient._id },
    {
      $push: {
        history: {
          type: 'tip',
          direction: 'in',
          amount: tip.amount,
          token: 'SOL',
          counterparty: tip.senderHandle,
          txHash: outcome.signature,
          status: outcome.status,
          date: new Date(),
        },
      },
      $pull: { pendingClaims: { fromTx: tip.tweetId } },
    }
  );

  const recipientName = tip.recipientHandle.replace(/^@/, '');
  await postTweet(
    `@${recipientName} ${tip.senderHandle} sent you ${tip.amount} SOL. It's already in your tip wallet — sign in at pourboire.tips to use it. ${explorerTxUrl(outcome.signature)}`,
    tip.tweetId
  );

  return 'settled';
}

/** Record an intent so the recipient can see it even before it settles. */
async function recordPendingClaim(tip: {
  tweetId: string;
  senderHandle: string;
  recipientHandle: string;
  amount: number;
  token: 'SOL' | 'USDC';
}) {
  const { user: recipient } = await ensureCustodialWallet({ handle: tip.recipientHandle });
  await User.updateOne(
    { _id: recipient._id, 'pendingClaims.fromTx': { $ne: tip.tweetId } },
    {
      $push: {
        pendingClaims: {
          amount: tip.amount,
          token: tip.token,
          fromTx: tip.tweetId,
          sender: tip.senderHandle,
          createdAt: new Date(),
        },
      },
    }
  );
}
