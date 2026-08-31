import 'server-only';
import Giveaway, { type IGiveaway } from '@/models/Giveaway';
import User, { type IUser } from '@/models/User';
import { commitmentFor, drawWinners, generateSeed, splitPrize } from './draw';
import { baseUrl } from './env';
import { renderReceipt } from './render-receipt';
import { estimateFeeWei, fetchBeacon, nativeBalance, tokenBalance } from './chain';
import { formatAmount } from './tokens';
import { parseTokenAmount, resolveToken, settleTransfer, type ResolvedToken } from './settle';
import { postTweet, uploadReceipt, fetchReplies } from './twitter';
import { ensureCustodialWallet, findUser } from './wallets';
import type { GiveawayCommand } from './tip-command';

/**
 * Giveaways, end to end.
 *
 * The interesting part is the ordering, which is what makes the draw verifiable:
 * a seed commitment is published when entries open, and the randomness beacon
 * that decides winners is a Robinhood Chain block hash from *after* entries close. See
 * `draw.ts` for why neither party can steer the result alone.
 */

/**
 * Announce a giveaway and start its entry window.
 *
 * The creator's balance is checked now so a giveaway that can never pay out is
 * rejected loudly at the start, rather than collecting hundreds of entries and
 * disappointing all of them.
 */
export async function openGiveaway(params: {
  tweetId: string;
  creatorHandle: string;
  command: GiveawayCommand;
}): Promise<boolean> {
  const { tweetId, creatorHandle, command } = params;

  let token: ResolvedToken;
  try {
    token = await resolveToken(command.token);
  } catch {
    await postTweet(
      `${creatorHandle} I don't recognise that token, so no giveaway was created.`,
      tweetId
    );
    return false;
  }

  const parsed = parseTokenAmount(command.amount, token);
  if (!parsed.ok) {
    await postTweet(`${creatorHandle} ${parsed.message}. No giveaway was created.`, tweetId);
    return false;
  }

  const perWinner = parsed.base / BigInt(command.winners);
  if (perWinner <= 0n) {
    await postTweet(
      `${creatorHandle} that prize splits to nothing per winner. No giveaway was created.`,
      tweetId
    );
    return false;
  }

  const creator = await findUser({ handle: creatorHandle });
  if (!creator?.encryptedPrivateKey || !creator.walletAddress) {
    await postTweet(
      `${creatorHandle} fund your tip wallet first, then try again.`,
      tweetId
    );
    return false;
  }

  const seed = generateSeed();
  const closesAt = new Date(Date.now() + command.durationMinutes * 60_000);

  try {
    await Giveaway.create({
      tweetId,
      creatorHandle,
      totalAmount: parsed.base.toString(),
      tokenSymbol: token.info.symbol,
      tokenMint: token.info.address,
      tokenDecimals: token.info.decimals,
      winnerCount: command.winners,
      closesAt,
      seedCommitment: commitmentFor(seed),
      seed,
      status: 'open',
    });
  } catch (e) {
    if ((e as { code?: number })?.code === 11000) return false;
    throw e;
  }

  // The verification address rides on the card, not in the text: a URL in the
  // tweet body costs $0.20 against $0.015 for a plain post, and text inside an
  // image is not parsed by X.
  const verifyPath = `${baseUrl().replace(/^https?:\/\//, '')}/giveaway/${tweetId}`;

  const media = await renderReceipt({
    kind: 'giveaway',
    from: creatorHandle,
    to: '',
    amount: formatAmount(parsed.base, token.info),
    color: token.info.color,
    winners: command.winners,
    footer: verifyPath,
  }).then((png) => (png ? uploadReceipt(png) : null));

  // The commitment goes out now, before anyone can enter. Publishing it later
  // would prove nothing.
  await postTweet(
    `🎁 ${formatAmount(parsed.base, token.info)} to ${command.winners} winners.\n\nReply to enter. Closes ${closesAt.toUTCString().slice(5, 22)} UTC.\n\nProvably fair — the draw is committed in advance:\n${commitmentFor(seed).slice(0, 32)}…`,
    tweetId,
    media
  );

  return true;
}

/** Draw and pay every giveaway whose window has closed. */
export async function settleDueGiveaways(budgetLeft: () => boolean): Promise<number> {
  const due = await Giveaway.find({ status: 'open', closesAt: { $lte: new Date() } })
    .sort({ closesAt: 1 })
    .limit(5);

  let settled = 0;
  for (const giveaway of due) {
    if (!budgetLeft()) break;
    try {
      if (await settleGiveaway(giveaway)) settled++;
    } catch (e) {
      console.error('[giveaway] settle failed', giveaway.tweetId, (e as Error)?.message);
    }
  }
  return settled;
}

async function settleGiveaway(giveaway: IGiveaway): Promise<boolean> {
  const voidOut = async (note: string, message: string) => {
    giveaway.status = 'void';
    giveaway.note = note;
    await giveaway.save();
    await postTweet(message, giveaway.tweetId);
  };

  /* ---------------------------------------------------- collect the entries */
  const replies = await fetchReplies(giveaway.tweetId);
  const entrants = [
    ...new Set(
      replies
        .map((r) => (r.author?.username ? `@${r.author.username.toLowerCase()}` : null))
        .filter((h): h is string => Boolean(h))
        // The creator cannot win their own giveaway.
        .filter((h) => h !== giveaway.creatorHandle)
    ),
  ];

  if (entrants.length === 0) {
    await voidOut('no entries', `${giveaway.creatorHandle} nobody entered, so nothing was paid out.`);
    return false;
  }

  /* -------------------------------------------------------------- the draw */
  const beacon = await fetchBeacon();
  const winners = drawWinners({
    seed: giveaway.seed!,
    beacon: beacon.hash,
    entries: entrants,
    winners: giveaway.winnerCount,
  });

  const shares = splitPrize(BigInt(giveaway.totalAmount), winners.length);

  giveaway.entries = entrants;
  giveaway.beaconSlot = beacon.slot;
  giveaway.beaconHash = beacon.hash;
  giveaway.status = 'drawn';
  await giveaway.save();

  /* ------------------------------------------------------------- the payout */
  const creator = await findUser({ handle: giveaway.creatorHandle });
  if (!creator?.encryptedPrivateKey) {
    await voidOut('creator wallet missing', `${giveaway.creatorHandle} your tip wallet is unavailable, so the giveaway could not pay out.`);
    return false;
  }

  const token = await resolveToken(giveaway.tokenMint ?? giveaway.tokenSymbol);

  // Resolve every winner to a wallet, creating one for those who never signed up.
  const targets: Array<{ handle: string; address: string; amount: bigint }> = [];
  for (const [i, handle] of winners.entries()) {
    const { user } = await ensureCustodialWallet({ handle });
    targets.push({ handle, address: user.walletAddress, amount: shares[i]! });
  }

  if (!(await creatorCanCover(creator, token, targets))) {
    await voidOut(
      'insufficient balance at draw time',
      `${giveaway.creatorHandle} your tip wallet no longer covers the prize, so the giveaway could not pay out. The winners were still drawn and are recorded on the verification page.`
    );
    return false;
  }

  // One transaction per winner: EVM cannot batch transfers into a single
  // instruction list the way Solana can, so a ten-winner draw is ten sends.
  // Gas on this chain is fractions of a cent, so the cost is noise; the reason
  // to care is that a partial failure leaves some winners paid and some not,
  // which is recorded rather than retried blindly.
  const signatures: string[] = [];
  for (const target of targets) {
    const result = await settleTransfer({
      sender: creator,
      recipientAddress: target.address,
      amount: target.amount,
      token,
    });

    if (!result.ok || result.outcome.status === 'failed') {
      giveaway.note = `payout to ${target.handle} failed: ${result.ok ? 'reverted' : result.message}`;
      await giveaway.save();
      break;
    }
    signatures.push(result.outcome.hash);

    const entry = {
      amount: target.amount.toString(),
      tokenSymbol: token.info.symbol,
      tokenMint: token.info.address,
      tokenDecimals: token.info.decimals,
      txHash: result.outcome.hash,
      status: result.outcome.status,
      date: new Date(),
    };
    const { user } = await ensureCustodialWallet({ handle: target.handle });
    await User.updateOne(
      { _id: user._id },
      {
        $push: {
          history: { ...entry, type: 'tip', direction: 'in', counterparty: giveaway.creatorHandle },
        },
      }
    );
    await User.updateOne(
      { _id: creator._id },
      {
        $push: {
          history: { ...entry, type: 'transfer', direction: 'out', counterparty: target.handle },
        },
      }
    );
  }

  giveaway.winners = targets.map((t) => ({
    handle: t.handle,
    walletAddress: t.address,
    amount: t.amount.toString(),
  }));
  giveaway.payoutTxHashes = signatures;
  giveaway.status = signatures.length ? 'settled' : 'void';
  // The seed is already stored; it becomes public via the verification page now
  // that the draw has happened.
  await giveaway.save();

  if (!signatures.length) return false;

  const media = await renderReceipt({
    kind: 'giveaway',
    from: giveaway.creatorHandle,
    to: '',
    amount: formatAmount(BigInt(giveaway.totalAmount), token.info),
    color: token.info.color,
    winners: winners.length,
    tx: `${signatures[0]!.slice(0, 8)}…${signatures[0]!.slice(-8)}`,
    footer: `${baseUrl().replace(/^https?:\/\//, '')}/giveaway/${giveaway.tweetId}`,
  }).then((png) => (png ? uploadReceipt(png) : null));

  const names = winners.slice(0, 10).join(' ');
  await postTweet(
    `🎉 Winners: ${names}${winners.length > 10 ? ` +${winners.length - 10} more` : ''}\n\n${formatAmount(shares[0]!, token.info)} each, paid.\n\nThe seed and the on-chain beacon are published — verification address on the card.`,
    giveaway.tweetId,
    media
  );

  return true;
}

/** Does the creator still hold enough to pay everyone? */
async function creatorCanCover(
  creator: IUser,
  token: ResolvedToken,
  targets: Array<{ address: string; amount: bigint }>
): Promise<boolean> {
  const total = targets.reduce((sum, t) => sum + t.amount, 0n);
  const address = creator.walletAddress;
  if (!address) return false;

  if (token.info.address === null) {
    // Native ETH pays both the prize and the gas for every payout.
    const balance = await nativeBalance(address as `0x${string}`);
    const gas = await estimateFeeWei(false);
    return balance >= total + gas * BigInt(targets.length);
  }

  // A token prize still needs ETH for gas on every transfer, so both are checked
  // — holding the prize but no gas is the state that would otherwise pay half
  // the winners and strand the rest.
  const [held, ethBalance, gas] = await Promise.all([
    tokenBalance(token.info.address, address as `0x${string}`),
    nativeBalance(address as `0x${string}`),
    estimateFeeWei(true),
  ]);
  return held >= total && ethBalance >= gas * BigInt(targets.length);
}
