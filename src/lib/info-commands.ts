import 'server-only';
import ProcessedTweet from '@/models/ProcessedTweet';
import User, { type ITransaction } from '@/models/User';
import type { ReceiptParams } from './receipt';
import { BOT_HANDLE, type InfoCommand } from './tip-command';
import { SOL, findTokenBySymbol, formatAmount } from './tokens';

/**
 * Answering the questions people tag the bot with.
 *
 * These commands move no money, which is what makes them safe to expose to
 * anyone who can type a mention. They are also the reason the bot is worth
 * tagging when you are not sending anything: `wallet @alice` turns any post into
 * a way to pay its author from a wallet app that has never heard of us.
 *
 * Two rules shape everything here:
 *
 *  1. **Only publish what is already public.** An address is public by
 *     construction; a balance is not. `balance` is deliberately absent — an
 *     in-thread answer would publish it permanently to everyone reading.
 *  2. **Every reply costs $0.015.** A command anyone can trigger, uncapped, is a
 *     way to run up someone else's bill, so answers are rationed per handle per
 *     day.
 */

/** Answers per handle per UTC day. Generous for a person, useless for a script. */
export const INFO_QUOTA_PER_DAY = 10;

export interface InfoReply {
  text: string;
  card: ReceiptParams | null;
}

/**
 * How many info answers this handle has already been given today.
 *
 * Counts only mentions we actually answered, so an attempt that was refused
 * does not spend quota it never used.
 */
export async function infoRepliesToday(senderHandle: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  return ProcessedTweet.countDocuments({
    senderHandle,
    commandKind: 'info',
    status: 'settled',
    createdAt: { $gte: startOfDay },
  });
}

/**
 * Build the answer to an info command.
 *
 * Subject resolution: an explicit `@handle` wins, then the author of the post
 * being replied to, then the asker. So a bare `@Pourboireonsol wallet` under
 * someone's post answers about *them*, which is how people read it.
 */
export async function buildInfoReply(params: {
  command: InfoCommand;
  senderHandle: string;
  replyToHandle: string | null;
}): Promise<InfoReply> {
  const { command, senderHandle, replyToHandle } = params;

  if (command.topic === 'help') return helpReply(senderHandle);

  const subject = command.subject ?? replyToHandle ?? senderHandle;
  const isSelf = subject === senderHandle;
  const user = await User.findOne({ handle: subject });

  if (command.topic === 'wallet') {
    if (!user?.walletAddress) {
      return {
        text: `${senderHandle} ${subject} doesn't have a tip wallet yet. Tip them anyway — one gets created and the tip waits there.`,
        card: null,
      };
    }
    return {
      text: `${senderHandle} here's ${isSelf ? 'your' : `${subject}'s`} tip wallet. Scan the code or copy the address off the card.`,
      card: {
        kind: 'wallet',
        from: BOT_HANDLE,
        to: subject,
        amount: '',
        color: SOL.color,
        qr: user.walletAddress,
        footer: 'pourboire.tips',
      },
    };
  }

  return statsReply({ subject, isSelf, senderHandle, history: user?.history ?? [] });
}

function helpReply(senderHandle: string): InfoReply {
  // Written out rather than generated from the parser: these are the forms
  // worth teaching, not every form that happens to parse.
  const lines = [
    'tip 0.5 SOL — pays whoever wrote the post',
    'tip 0.5 SOL @alice — pays someone specific',
    'tip 1 SOL each @a @b — pays both',
    'split 3 SOL @a @b @c — divides between them',
    'giveaway 5 SOL to 10 in 2h — draws winners',
    'wallet @alice — shows their tip address',
  ];

  return {
    text: `${senderHandle} here's what I understand — reply to any post with one of these.`,
    card: {
      kind: 'help',
      from: BOT_HANDLE,
      to: '',
      amount: '',
      color: SOL.color,
      lines: lines.join('\n'),
      footer: 'pourboire.tips',
    },
  };
}

function statsReply(params: {
  subject: string;
  isSelf: boolean;
  senderHandle: string;
  history: ITransaction[];
}): InfoReply {
  const { subject, isSelf, senderHandle, history } = params;

  // Received tips only. What someone sent, withdrew, or currently holds is
  // theirs to publish, not ours — the same boundary the public profile pages
  // draw.
  const received = history.filter((h) => h.direction === 'in' && h.status !== 'failed');

  if (received.length === 0) {
    return {
      text: `${senderHandle} ${isSelf ? "you haven't" : `${subject} hasn't`} received any tips yet.`,
      card: null,
    };
  }

  // Summed in base units per token: adding decimal strings would reintroduce
  // exactly the float error the rest of the money path avoids.
  const totals = new Map<string, { raw: bigint; decimals: number }>();
  for (const h of received) {
    const existing = totals.get(h.tokenSymbol);
    const raw = BigInt(h.amount);
    totals.set(h.tokenSymbol, {
      raw: (existing?.raw ?? 0n) + raw,
      decimals: h.tokenDecimals,
    });
  }

  const formatted = [...totals.entries()]
    .map(([symbol, { raw, decimals }]) => {
      const known = findTokenBySymbol(symbol);
      return formatAmount(raw, known ?? { ...SOL, symbol, decimals });
    })
    // Four lines leaves room for the two summary lines below without shrinking
    // the type on the card.
    .slice(0, 4);

  const senders = new Set(received.map((h) => h.counterparty));

  const lines = [
    ...formatted,
    `from ${senders.size} ${senders.size === 1 ? 'person' : 'people'}`,
    `${received.length} ${received.length === 1 ? 'tip' : 'tips'} in total`,
  ];

  const soleToken = totals.size === 1 ? findTokenBySymbol([...totals.keys()][0]!) : null;

  return {
    text: `${senderHandle} here's what ${isSelf ? 'you have' : `${subject} has`} received through Pourboire.`,
    card: {
      kind: 'stats',
      from: BOT_HANDLE,
      to: subject,
      amount: '',
      color: soleToken?.color ?? SOL.color,
      lines: lines.join('\n'),
      footer: `pourboire.tips/${subject.replace(/^@/, '')}`,
    },
  };
}
