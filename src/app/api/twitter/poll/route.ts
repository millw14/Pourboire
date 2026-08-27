import { NextRequest } from 'next/server';
import connectDB from '@/lib/mongodb';
import { requireMachineCaller } from '@/lib/auth';
import { handleError, ok } from '@/lib/api';
import { searchMentions, postTweet, uploadReceipt, type Mention } from '@/lib/twitter';
import {
  parseCommand,
  BOT_HANDLE,
  type TipCommand,
  type GiveawayCommand,
  type InfoCommand,
} from '@/lib/tip-command';
import { buildInfoReply, infoRepliesToday, INFO_QUOTA_PER_DAY } from '@/lib/info-commands';
import { renderReceipt } from '@/lib/render-receipt';
import { formatAmount } from '@/lib/tokens';
import { parseTokenAmount, resolveToken, settleTransfer } from '@/lib/settle';
import { openGiveaway, settleDueGiveaways } from '@/lib/giveaway';
import User from '@/models/User';
import ProcessedTweet from '@/models/ProcessedTweet';
import PollCursor, { MENTIONS_CURSOR } from '@/models/PollCursor';
import { ensureCustodialWallet, findUser } from '@/lib/wallets';

/**
 * Read new @Pourboireonsol mentions, settle the commands in them, and pay out
 * any giveaways whose entry window has closed.
 *
 * Two properties matter here, both of which the original lacked:
 *
 *  1. **It is not public.** It signs transfers out of user wallets, so it
 *     requires CRON_SECRET and refuses to run at all if that is unset.
 *
 *  2. **Each tweet acts at most once, ever.** A tweet id is claimed in
 *     ProcessedTweet *before* anything is attempted. The unique index makes that
 *     claim atomic, so overlapping runs cannot double-send.
 */

export const maxDuration = 300;

/** Leave room to finish and record results rather than being killed mid-transfer. */
const TIME_BUDGET_MS = 240_000;

export async function GET(req: NextRequest) {
  // Vercel Cron issues GET with `Authorization: Bearer $CRON_SECRET` attached
  // automatically. POST is kept for manual runs and other schedulers.
  return POST(req);
}

export async function POST(req: NextRequest) {
  try {
    requireMachineCaller(req);
    await connectDB();

    const startedAt = Date.now();
    const budgetLeft = () => Date.now() - startedAt < TIME_BUDGET_MS;

    const cursor = await PollCursor.findOneAndUpdate(
      { key: MENTIONS_CURSOR },
      { $setOnInsert: { key: MENTIONS_CURSOR } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const tweets = await searchMentions(`${BOT_HANDLE} -is:retweet`, cursor.sinceId);

    let settled = 0;
    let deferred = 0;
    let skipped = 0;
    let giveawaysOpened = 0;

    if (tweets.length) {
      // Tweet ids are snowflakes: numerically increasing, so max is newest.
      let highWater = cursor.sinceId;
      for (const t of tweets) {
        if (!highWater || BigInt(t.id) > BigInt(highWater)) highWater = String(t.id);
      }

      // Oldest first, so a partial run leaves a contiguous processed prefix.
      const ordered = [...tweets].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

      for (const tweet of ordered) {
        if (!budgetLeft()) {
          // Stop cleanly and let the next run continue from the cursor rather
          // than being killed partway through a transfer.
          highWater = undefined;
          break;
        }

        const outcome = await handleMention(tweet);
        if (outcome === 'settled') settled++;
        else if (outcome === 'giveaway') giveawaysOpened++;
        else if (outcome === 'deferred') deferred++;
        else skipped++;
      }

      if (highWater) cursor.sinceId = highWater;
    }

    cursor.lastRunAt = new Date();
    cursor.lastError = undefined;
    await cursor.save();

    // Tips that could not settle earlier — usually an unfunded sender — are
    // retried here, which is what lets the pending list resolve itself.
    const retried = budgetLeft() ? await retryPending(budgetLeft) : 0;

    // Giveaways whose window has closed get drawn and paid.
    const giveawaysSettled = budgetLeft() ? await settleDueGiveaways(budgetLeft) : 0;

    return ok({
      processed: settled + retried,
      deferred,
      skipped,
      scanned: tweets.length,
      giveawaysOpened,
      giveawaysSettled,
    });
  } catch (e) {
    return handleError('twitter/poll', e);
  }
}

type MentionOutcome = 'settled' | 'deferred' | 'skipped' | 'giveaway';

async function handleMention(tweet: Mention): Promise<MentionOutcome> {
  const command = parseCommand(tweet.text ?? '');
  if (!command) return 'skipped';

  const senderHandle = tweet.author?.username ? `@${tweet.author.username.toLowerCase()}` : null;
  if (!senderHandle) return 'skipped';

  // ---- Claim the tweet. First writer wins; everyone else skips. ----
  try {
    await ProcessedTweet.create({
      tweetId: String(tweet.id),
      status: 'claimed',
      commandKind: command.kind,
      senderHandle,
      amount: command.kind === 'info' ? undefined : command.amount,
      token: command.kind === 'info' ? undefined : command.token,
    });
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 11000) return 'skipped';
    throw e;
  }

  if (command.kind === 'info') {
    return answerInfo(tweet, senderHandle, command);
  }

  if (command.kind === 'giveaway') {
    const opened = await openGiveaway({
      tweetId: String(tweet.id),
      creatorHandle: senderHandle,
      command: command as GiveawayCommand,
    });
    await ProcessedTweet.updateOne(
      { tweetId: String(tweet.id) },
      { $set: { status: opened ? 'settled' : 'failed', note: opened ? 'giveaway opened' : 'giveaway rejected' } }
    );
    return opened ? 'giveaway' : 'deferred';
  }

  return settleTip(tweet, senderHandle, command);
}

/**
 * Answer a question. No money moves, so the only cost to control is the reply
 * itself — $0.015 each, which anyone can trigger by typing a mention.
 */
async function answerInfo(
  tweet: Mention,
  senderHandle: string,
  command: InfoCommand
): Promise<MentionOutcome> {
  const tweetId = String(tweet.id);
  const mark = (status: string, note?: string) =>
    ProcessedTweet.updateOne({ tweetId }, { $set: { status, ...(note ? { note } : {}) } });

  const used = await infoRepliesToday(senderHandle);
  if (used >= INFO_QUOTA_PER_DAY) {
    // Silently. Replying "you've hit your limit" would itself cost $0.015 and
    // hand a spammer exactly the reply they were trying to extract.
    await mark('failed', `info quota reached (${used})`);
    return 'skipped';
  }

  const replyToHandle = tweet.replyToAuthor?.username
    ? `@${tweet.replyToAuthor.username.toLowerCase()}`
    : null;

  let reply;
  try {
    reply = await buildInfoReply({ command, senderHandle, replyToHandle });
  } catch (e) {
    await mark('failed', `info build failed: ${(e as Error).message}`);
    return 'skipped';
  }

  const media = reply.card ? await renderReceipt(reply.card).then((png) => (png ? uploadReceipt(png) : null)) : null;

  const posted = await postTweet(reply.text, tweetId, media);
  await mark(posted ? 'settled' : 'failed', posted ? `info:${command.topic}` : 'info reply failed');
  return posted ? 'settled' : 'skipped';
}

/** Work out who a tip is for: explicit handles, or the author of the parent post. */
function resolveRecipients(tweet: Mention, senderHandle: string, command: TipCommand): string[] {
  if (command.recipients.length > 0) {
    return command.recipients.filter((h) => h !== senderHandle);
  }
  const replyTarget = tweet.replyToAuthor?.username
    ? `@${tweet.replyToAuthor.username.toLowerCase()}`
    : null;
  if (!replyTarget || replyTarget === senderHandle) return [];
  return [replyTarget];
}

async function settleTip(
  tweet: Mention,
  senderHandle: string,
  command: TipCommand,
  opts: { quiet?: boolean } = {}
): Promise<MentionOutcome> {
  const tweetId = String(tweet.id);
  const mark = (status: string, fields: Record<string, unknown> = {}) =>
    ProcessedTweet.updateOne({ tweetId }, { $set: { status, ...fields } });

  // On a retry we stay quiet about the same failure — otherwise every poll run
  // posts another "please fund your wallet" reply under the same tweet.
  const notify = (text: string, mediaId?: string | null) =>
    opts.quiet ? Promise.resolve(null) : postTweet(text, tweetId, mediaId);

  const recipients = resolveRecipients(tweet, senderHandle, command);
  if (recipients.length === 0) {
    await mark('failed', { note: 'no recipient' });
    return 'skipped';
  }

  let token;
  try {
    token = await resolveToken(command.token);
  } catch (e) {
    await mark('failed', { note: `unknown token: ${(e as Error).message}` });
    await notify(`${senderHandle} I don't recognise that token, so nothing was sent.`);
    return 'deferred';
  }

  const parsed = parseTokenAmount(command.amount, token);
  if (!parsed.ok) {
    await mark('failed', { note: parsed.message });
    await notify(`${senderHandle} ${parsed.message}. Nothing was sent.`);
    return 'deferred';
  }

  // `each` pays every recipient the full amount; `split` divides it.
  const perRecipient =
    command.mode === 'split'
      ? parsed.base / BigInt(recipients.length)
      : parsed.base;

  if (perRecipient <= 0n) {
    await mark('failed', { note: 'amount rounds to zero per recipient' });
    await notify(`${senderHandle} that splits to nothing each. Nothing was sent.`);
    return 'deferred';
  }

  const sender = await findUser({ handle: senderHandle });
  if (!sender?.encryptedPrivateKey || !sender.walletAddress) {
    await mark('pending', { note: 'sender has no funded tip wallet' });
    await recordPendingClaims(recipients, tweetId, senderHandle, perRecipient, token);
    await notify(
      `${recipients.join(' ')} ${senderHandle} wants to tip you ${formatAmount(perRecipient, token.info)}, but needs to fund their tip wallet first. It arrives automatically once they do.`
    );
    return 'deferred';
  }

  const paid: Array<{ handle: string; signature: string }> = [];
  let lastFailure = '';

  for (const handle of recipients) {
    const { user: recipient } = await ensureCustodialWallet({ handle });

    const result = await settleTransfer({
      sender,
      recipientAddress: recipient.walletAddress,
      token,
      amount: perRecipient,
    });

    if (!result.ok) {
      lastFailure = result.message;
      break;
    }
    if (result.outcome.status === 'failed') {
      lastFailure = 'the network rejected the transfer';
      break;
    }

    const entry = {
      amount: perRecipient.toString(),
      tokenSymbol: token.info.symbol,
      tokenMint: token.info.mint,
      tokenDecimals: token.info.decimals,
      txHash: result.outcome.signature,
      status: result.outcome.status,
      date: new Date(),
    };

    await User.updateOne(
      { _id: sender._id },
      { $push: { history: { ...entry, type: 'transfer', direction: 'out', counterparty: handle } } }
    );
    // $push/$pull rather than reassigning the array: the old code replaced
    // `pendingClaims` wholesale and silently discarded concurrent writes.
    await User.updateOne(
      { _id: recipient._id },
      {
        $push: { history: { ...entry, type: 'tip', direction: 'in', counterparty: senderHandle } },
        $pull: { pendingClaims: { fromTx: tweetId } },
      }
    );

    paid.push({ handle, signature: result.outcome.signature });
  }

  if (paid.length === 0) {
    await mark('pending', { note: lastFailure || 'transfer failed' });
    await recordPendingClaims(recipients, tweetId, senderHandle, perRecipient, token);
    await notify(`${senderHandle} ${lastFailure || "that tip didn't go through"}. Nothing was sent.`);
    return 'deferred';
  }

  const partial = paid.length < recipients.length;
  await mark(partial ? 'pending' : 'settled', {
    txHash: paid[0]!.signature,
    note: partial ? `paid ${paid.length}/${recipients.length}: ${lastFailure}` : undefined,
  });

  // The receipt card. A failure to render it costs the picture, not the reply.
  //
  // The transaction signature and the site address live on the card rather than
  // in the tweet text: X bills a post containing a URL at $0.20 against $0.015
  // for a plain one, which on a small tip is a fifth of the tip's value. Text
  // inside an image is not parsed, so the reader still gets both.
  const media = await renderReceipt({
    kind: 'tip',
    from: senderHandle,
    to: paid.length === 1 ? paid[0]!.handle : `${paid.length} people`,
    amount: formatAmount(perRecipient, token.info),
    color: token.info.color,
    tx: `${paid[0]!.signature.slice(0, 8)}…${paid[0]!.signature.slice(-8)}`,
    footer: `pourboire.tips/${paid[0]!.handle}`,
  }).then((png) => (png ? uploadReceipt(png) : null));

  const who = paid.map((p) => p.handle).join(' ');
  await postTweet(
    `${who} ${senderHandle} sent you ${formatAmount(perRecipient, token.info)}. It's already in your tip wallet — receipt below.`,
    tweetId,
    media
  );

  return 'settled';
}

/** Record intents so recipients see them even before they settle. */
async function recordPendingClaims(
  recipients: string[],
  tweetId: string,
  senderHandle: string,
  amount: bigint,
  token: { info: { symbol: string; mint: string | null; decimals: number } }
) {
  for (const handle of recipients) {
    const { user } = await ensureCustodialWallet({ handle });
    await User.updateOne(
      { _id: user._id, 'pendingClaims.fromTx': { $ne: tweetId } },
      {
        $push: {
          pendingClaims: {
            amount: amount.toString(),
            tokenSymbol: token.info.symbol,
            tokenMint: token.info.mint,
            tokenDecimals: token.info.decimals,
            fromTx: tweetId,
            sender: senderHandle,
            createdAt: new Date(),
          },
        },
      }
    );
  }
}

/** How long a tip keeps being retried before we stop trying. */
const RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Re-attempt tips that parsed correctly but could not be paid at the time.
 *
 * Only `pending` and `failed` rows are eligible — never `unconfirmed`, because
 * an unconfirmed transfer may still land and retrying it would send the money
 * twice, which is exactly what this ledger exists to prevent.
 */
async function retryPending(budgetLeft: () => boolean): Promise<number> {
  const candidates = await ProcessedTweet.find({
    status: { $in: ['pending', 'failed'] },
    createdAt: { $gt: new Date(Date.now() - RETRY_WINDOW_MS) },
  })
    .sort({ createdAt: 1 })
    .limit(50);

  let settled = 0;
  for (const row of candidates) {
    if (!budgetLeft()) break;
    if (!row.senderHandle || !row.amount || !row.token) continue;

    // Re-fetch the original tweet's parsed intent from the stored fields.
    const fake: Mention = {
      id: row.tweetId,
      text: '',
      author: undefined,
      replyToAuthor: undefined,
    };
    const command: TipCommand = {
      kind: 'tip',
      amount: row.amount,
      token: row.token,
      recipientHandle: row.recipientHandle ?? null,
      mode: 'single',
      recipients: row.recipientHandle ? [row.recipientHandle] : [],
    };
    if (command.recipients.length === 0) continue;

    const result = await settleTip(fake, row.senderHandle, command, { quiet: true });
    if (result === 'settled') settled++;
  }
  return settled;
}
