import 'server-only';
import { Keypair, PublicKey } from '@solana/web3.js';
import Giveaway, { type IGiveaway } from '@/models/Giveaway';
import User from '@/models/User';
import { decryptPrivateKey } from './crypto';
import { commitmentFor, drawWinners, generateSeed, splitPrize } from './draw';
import { baseUrl } from './env';
import { renderReceipt } from './render-receipt';
import { explorerTxUrl, fetchBeacon, getConnection, spendableLamports } from './solana';
import { buildSolPayouts, buildSplTransfer, recipientNeedsAccount, sendInstructions } from './spl';
import { formatAmount } from './tokens';
import { parseTokenAmount, resolveToken, type ResolvedToken } from './settle';
import { postTweet, uploadReceipt, fetchReplies } from './twitter';
import { ensureCustodialWallet, findUser } from './wallets';
import type { GiveawayCommand } from './tip-command';

/**
 * Giveaways, end to end.
 *
 * The interesting part is the ordering, which is what makes the draw verifiable:
 * a seed commitment is published when entries open, and the randomness beacon
 * that decides winners is a Solana blockhash from *after* entries close. See
 * `draw.ts` for why neither party can steer the result alone.
 */

/** Solana fits roughly this many transfers in one transaction. */
const PAYOUTS_PER_TX = 8;

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
      `${creatorHandle} sign in at pourboire.tips and fund your tip wallet first, then try again.`,
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
      tokenMint: token.info.mint,
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

  const media = await renderReceipt({
    kind: 'giveaway',
    from: creatorHandle,
    to: '',
    amount: formatAmount(parsed.base, token.info),
    color: token.info.color,
    winners: command.winners,
  }).then((png) => (png ? uploadReceipt(png) : null));

  // The commitment goes out now, before anyone can enter. Publishing it later
  // would prove nothing.
  await postTweet(
    `🎁 ${formatAmount(parsed.base, token.info)} to ${command.winners} winners.\n\nReply to enter. Closes ${closesAt.toUTCString().slice(5, 22)} UTC.\n\nProvably fair — commitment ${commitmentFor(seed).slice(0, 16)}…\nVerify: ${baseUrl()}/giveaway/${tweetId}`,
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

  const keypair = Keypair.fromSecretKey(await decryptPrivateKey(creator.encryptedPrivateKey));
  const token = await resolveToken(giveaway.tokenMint ?? giveaway.tokenSymbol);

  // Resolve every winner to a wallet, creating one for those who never signed up.
  const targets: Array<{ handle: string; address: PublicKey; amount: bigint }> = [];
  for (const [i, handle] of winners.entries()) {
    const { user } = await ensureCustodialWallet({ handle });
    targets.push({ handle, address: new PublicKey(user.walletAddress), amount: shares[i]! });
  }

  if (!(await creatorCanCover(keypair, token, targets))) {
    await voidOut(
      'insufficient balance at draw time',
      `${giveaway.creatorHandle} your tip wallet no longer covers the prize, so the giveaway could not pay out. Winners were drawn and are recorded at ${baseUrl()}/giveaway/${giveaway.tweetId}`
    );
    return false;
  }

  const signatures: string[] = [];
  for (let i = 0; i < targets.length; i += PAYOUTS_PER_TX) {
    const batch = targets.slice(i, i + PAYOUTS_PER_TX);
    const instructions = [];

    for (const target of batch) {
      if (!token.mint) {
        instructions.push(
          ...buildSolPayouts(keypair.publicKey, [
            { to: target.address, lamports: Number(target.amount) },
          ])
        );
      } else {
        const plan = buildSplTransfer({
          from: keypair.publicKey,
          to: target.address,
          amount: target.amount,
          resolved: token.mint,
          needsAccount: await recipientNeedsAccount(target.address, token.mint),
        });
        instructions.push(...plan.instructions);
      }
    }

    const outcome = await sendInstructions(keypair, instructions);
    if (outcome.status === 'failed') {
      giveaway.note = `payout batch ${i / PAYOUTS_PER_TX} failed: ${outcome.reason}`;
      await giveaway.save();
      break;
    }
    signatures.push(outcome.signature);

    // Record history for the batch that just landed.
    for (const target of batch) {
      const entry = {
        amount: target.amount.toString(),
        tokenSymbol: token.info.symbol,
        tokenMint: token.info.mint,
        tokenDecimals: token.info.decimals,
        txHash: outcome.signature,
        status: outcome.status,
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
  }

  giveaway.winners = targets.map((t) => ({
    handle: t.handle,
    walletAddress: t.address.toString(),
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
    tx: `${signatures[0]!.slice(0, 6)}…${signatures[0]!.slice(-6)}`,
  }).then((png) => (png ? uploadReceipt(png) : null));

  const names = winners.slice(0, 10).join(' ');
  await postTweet(
    `🎉 Winners: ${names}${winners.length > 10 ? ` +${winners.length - 10} more` : ''}\n\n${formatAmount(shares[0]!, token.info)} each, paid.\n\nVerify the draw: ${baseUrl()}/giveaway/${giveaway.tweetId}\n${explorerTxUrl(signatures[0]!)}`,
    giveaway.tweetId,
    media
  );

  return true;
}

/** Does the creator still hold enough to pay everyone, including account rent? */
async function creatorCanCover(
  keypair: Keypair,
  token: ResolvedToken,
  targets: Array<{ address: PublicKey; amount: bigint }>
): Promise<boolean> {
  const total = targets.reduce((sum, t) => sum + t.amount, 0n);

  if (!token.mint) {
    const balance = await getConnection().getBalance(keypair.publicKey, 'confirmed');
    return BigInt(spendableLamports(balance)) >= total;
  }

  const { tokenBalance } = await import('./spl');
  const held = await tokenBalance(keypair.publicKey, token.mint);
  return held >= total;
}
