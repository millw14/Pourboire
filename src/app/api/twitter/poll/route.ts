import { NextRequest } from 'next/server';
import connectDB from '@/lib/mongodb';
import { requireMachineCaller } from '@/lib/auth';
import { handleError, ok } from '@/lib/api';
import {
  searchMentions,
  fetchReplies,
  postTweet,
  uploadReceipt,
  type Mention,
} from '@/lib/twitter';
import {
  parseCommand,
  retiredSymbolIn,
  BOT_HANDLE,
  type TipCommand,
  type GiveawayCommand,
  type InfoCommand,
  type RainCommand,
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
  const senderHandle = tweet.author?.username ? `@${tweet.author.username.toLowerCase()}` : null;

  if (!command) {
    // A command naming a token from before the chain move parses to nothing, by
    // design — the alternative was reading `tip 100000 BONK` as 100,000 USDG.
    // Say so once, rather than leaving the bot looking broken to everyone who
    // learned the old syntax.
    const retired = retiredSymbolIn(tweet.text ?? '');
    if (retired && senderHandle) {
      try {
        await ProcessedTweet.create({
          tweetId: String(tweet.id),
          status: 'settled',
          commandKind: 'info',
          senderHandle,
          note: `retired symbol ${retired}`,
        });
      } catch (e) {
        // Already answered by another run.
        if ((e as { code?: number })?.code === 11000) return 'skipped';
        throw e;
      }
      await postTweet(
        `${senderHandle} ${retired} isn't supported here any more — tips run on Robinhood Chain now. Try USDG, ETH, or a ticker like NVDA.`,
        String(tweet.id)
      );
      return 'skipped';
    }
    return 'skipped';
  }

  if (!senderHandle) return 'skipped';

  // ---- Claim the tweet. First writer wins; everyone else skips. ----
  try {
    await ProcessedTweet.create({
      tweetId: String(tweet.id),
      status: 'claimed',
      commandKind: command.kind === 'info' ? 'info' : command.kind === 'giveaway' ? 'giveaway' : 'tip',
      senderHandle,
      // info and match carry no amount of their own: info asks a question, and
      // match takes its amount from the post it replies to.
      amount: 'amount' in command ? command.amount : undefined,
      token: 'token' in command ? command.token : undefined,
    });
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 11000) return 'skipped';
    throw e;
  }

  if (command.kind === 'info') {
    return answerInfo(tweet, senderHandle, command);
  }

  if (command.kind === 'rain') {
    return settleRain(tweet, senderHandle, command);
  }

  if (command.kind === 'match') {
    return settleMatch(tweet, senderHandle);
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

/**
 * Hard ceiling on how many people one `rain` can reach.
 *
 * Reading a thread is $0.005 per post plus $0.010 per unique author, and each
 * payout is its own on-chain transfer with its own fee. Both costs are the
 * sender's, so the bound is fixed here rather than taken from the tweet.
 */
const RAIN_MAX_RECIPIENTS = 25;

/** How much of a thread to read looking for recipients. 100 posts is $0.50. */
const RAIN_SCAN_LIMIT = 100;

/**
 * Turn `rain` into an ordinary split tip by discovering who replied.
 *
 * Recipients are the most recent distinct repliers, excluding the sender, the
 * bot, and anyone who appears twice.
 */
async function settleRain(
  tweet: Mention,
  senderHandle: string,
  command: RainCommand
): Promise<MentionOutcome> {
  const tweetId = String(tweet.id);
  const mark = (status: string, fields: Record<string, unknown> = {}) =>
    ProcessedTweet.updateOne({ tweetId }, { $set: { status, ...fields } });

  const conversationId = tweet.conversationId;
  if (!conversationId) {
    await mark('failed', { note: 'no conversation to rain on' });
    await postTweet(
      `${senderHandle} reply to a post with rain and I'll split it between the people replying there.`,
      tweetId
    );
    return 'skipped';
  }

  let replies: Mention[];
  try {
    replies = await fetchReplies(conversationId, RAIN_SCAN_LIMIT);
  } catch (e) {
    await mark('failed', { note: `thread read failed: ${(e as Error).message}` });
    return 'deferred';
  }

  const seen = new Set<string>([senderHandle]);
  const recipients: string[] = [];
  // Newest first: raining on a long thread should reach the people currently in
  // it, not whoever happened to reply when it was posted.
  for (const reply of [...replies].reverse()) {
    const handle = reply.author?.username ? `@${reply.author.username.toLowerCase()}` : null;
    if (!handle || seen.has(handle) || /^@pourboire(onsol)?$/i.test(handle)) continue;
    seen.add(handle);
    recipients.push(handle);
    if (recipients.length >= Math.min(command.maxRecipients, RAIN_MAX_RECIPIENTS)) break;
  }

  if (recipients.length === 0) {
    await mark('failed', { note: 'no one to rain on' });
    await postTweet(`${senderHandle} nobody has replied there yet, so there was no one to pay.`, tweetId);
    return 'skipped';
  }

  // Rain is `split` with a discovered recipient list, so it settles through
  // exactly the same path — including the rent-exemption floor and the
  // per-recipient failure handling.
  const asTip: TipCommand = {
    kind: 'tip',
    amount: command.amount,
    token: command.token,
    recipientHandle: null,
    mode: 'split',
    recipients,
  };

  await mark('claimed', { recipientHandle: recipients[0], note: `rain to ${recipients.length}` });
  return settleTip(tweet, senderHandle, asTip);
}

/**
 * Repeat the tip in the post being replied to.
 *
 * Resolved from our own ledger, by either the original command's id or the id of
 * the bot's confirmation, so it costs no extra API reads.
 */
async function settleMatch(tweet: Mention, senderHandle: string): Promise<MentionOutcome> {
  const tweetId = String(tweet.id);
  const mark = (status: string, fields: Record<string, unknown> = {}) =>
    ProcessedTweet.updateOne({ tweetId }, { $set: { status, ...fields } });

  const parentId = tweet.repliedToTweetId;
  if (!parentId) {
    await mark('failed', { note: 'match with no parent' });
    await postTweet(`${senderHandle} reply to a tip with match and I'll send the same again.`, tweetId);
    return 'skipped';
  }

  const original = await ProcessedTweet.findOne({
    $or: [{ tweetId: parentId }, { replyTweetId: parentId }],
    commandKind: 'tip',
    status: { $in: ['settled', 'pending'] },
  });

  if (!original?.amount || !original.token || !original.recipientHandle) {
    await mark('failed', { note: 'no matchable tip on parent' });
    await postTweet(
      `${senderHandle} I can't find a tip on that post to match. Reply directly to one and try again.`,
      tweetId
    );
    return 'skipped';
  }

  if (original.recipientHandle === senderHandle) {
    // Matching a tip you received would pay it straight back to yourself.
    await mark('failed', { note: 'match would pay self' });
    return 'skipped';
  }

  const asTip: TipCommand = {
    kind: 'tip',
    amount: original.amount,
    token: original.token,
    recipientHandle: original.recipientHandle,
    mode: 'single',
    recipients: [original.recipientHandle],
  };

  await mark('claimed', {
    amount: original.amount,
    token: original.token,
    recipientHandle: original.recipientHandle,
    note: `match of ${parentId}`,
  });
  return settleTip(tweet, senderHandle, asTip);
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
  let indeterminate = false;

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

    const outcome = result.outcome;

    if (outcome.status === 'failed' || outcome.status === 'rejected') {
      lastFailure = 'the network rejected the transfer';
      break;
    }

    // Submission itself failed in a way that cannot tell "never sent" from
    // "sent, response lost". Stop the loop and mark the whole tip indeterminate:
    // there is no hash to record and it must never be retried automatically.
    if (outcome.status === 'unknown') {
      lastFailure = 'we lost contact with the network mid-send';
      indeterminate = true;
      break;
    }

    const entry = {
      amount: perRecipient.toString(),
      tokenSymbol: token.info.symbol,
      tokenMint: token.info.address,
      tokenDecimals: token.info.decimals,
      txHash: outcome.hash,
      status: outcome.status,
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

    paid.push({ handle, signature: outcome.hash });
  }

  if (paid.length === 0) {
    // `indeterminate` means a send may have gone out with no hash to show for
    // it. Retrying that would be the double-send this ledger exists to prevent,
    // so it is parked for an operator rather than queued.
    await mark(indeterminate ? 'unconfirmed' : 'pending', {
      note: lastFailure || 'transfer failed',
    });
    if (!indeterminate) {
      await recordPendingClaims(recipients, tweetId, senderHandle, perRecipient, token);
    }
    await notify(`${senderHandle} ${lastFailure || "that tip didn't go through"}. Nothing was sent.`);
    return 'deferred';
  }

  const partial = paid.length < recipients.length;

  // A partially-paid tip is terminal, not pending.
  //
  // `pending` is the retry queue, and retryPending rebuilds a row as a *single*
  // tip to `recipientHandle` for the row's `amount` — which is the original
  // total. A half-finished `split 30 USDG @a @b @c` would therefore come back as
  // "send @a 30 USDG", paying the one person who already got their share the
  // whole prize again, every run, for a week. So partial rows get their own
  // status that retryPending does not select, and never carry a recipientHandle.
  await mark(partial ? 'partial' : 'settled', {
    txHash: paid[0]!.signature,
    note: partial
      ? `paid ${paid.length}/${recipients.length} (${paid.map((p) => p.handle).join(' ')}): ${lastFailure}`
      : undefined,
  });

  if (partial) {
    // The unpaid tail still gets a claim recorded, so those people can see the
    // intent even though this row will not be retried automatically.
    await recordPendingClaims(
      recipients.filter((h) => !paid.some((p) => p.handle === h)),
      tweetId,
      senderHandle,
      perRecipient,
      token
    );
  }

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
  const replyTweetId = await postTweet(
    `${who} ${senderHandle} sent you ${formatAmount(perRecipient, token.info)}. It's already in your tip wallet — receipt below.`,
    tweetId,
    media
  );

  // Recorded so `match` can resolve from either the original command or the
  // bot's own confirmation — people reply to whichever is in front of them.
  //
  // `recipientHandle` is written only for a fully-settled single tip. On a
  // partial it would name someone already paid, and on a split it would pair one
  // handle with the row's *total* amount — the shape `match` and `retryPending`
  // both read back, and both would then re-send the whole total to that person.
  await mark(partial ? 'partial' : 'settled', {
    ...(!partial && command.mode === 'single' ? { recipientHandle: paid[0]!.handle } : {}),
    ...(replyTweetId ? { replyTweetId } : {}),
  });

  return 'settled';
}

/** Record intents so recipients see them even before they settle. */
async function recordPendingClaims(
  recipients: string[],
  tweetId: string,
  senderHandle: string,
  amount: bigint,
  token: { info: { symbol: string; address: string | null; decimals: number } }
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
            tokenMint: token.info.address,
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
