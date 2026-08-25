import 'server-only';
import { Keypair, PublicKey } from '@solana/web3.js';
import { decryptPrivateKey } from './crypto';
import {
  getConnection,
  spendableLamports,
  transferLamports,
  type TransferOutcome,
} from './solana';
import {
  buildSplTransfer,
  recipientNeedsAccount,
  resolveMint,
  sendInstructions,
  tokenBalance,
  type ResolvedMint,
} from './spl';
import {
  ATA_RENT_LAMPORTS,
  SOL,
  findTokenBySymbol,
  formatAmount,
  toBaseUnits,
  type TokenInfo,
} from './tokens';
import type { IUser } from '@/models/User';

/**
 * Moving value, whichever token it is.
 *
 * Tips and giveaway payouts both land here so there is one implementation of
 * "does the sender actually have this, and what does it cost them" — the sort of
 * check that was previously copied into each route with slightly different
 * arithmetic each time.
 */

export interface ResolvedToken {
  info: TokenInfo;
  /** Present for SPL tokens, absent for native SOL. */
  mint: ResolvedMint | null;
}

/**
 * Turn a token as written in a tweet into something we can transfer.
 *
 * A known symbol resolves from the registry. Anything else must be a mint
 * address, which we read from the chain — we never guess a symbol for an unknown
 * mint, since a spoofed symbol is precisely how a scam token gets tipped.
 */
export async function resolveToken(token: string): Promise<ResolvedToken> {
  const known = findTokenBySymbol(token);
  if (known) {
    if (known.mint === null) return { info: known, mint: null };
    return { info: known, mint: await resolveMint(known.mint) };
  }

  // Not a symbol we know; treat it as a mint address.
  const resolved = await resolveMint(token);
  return { info: resolved.info, mint: resolved };
}

export type SettleFailure =
  | { ok: false; reason: 'insufficient'; message: string }
  | { ok: false; reason: 'dust'; message: string }
  | { ok: false; reason: 'error'; message: string };

export type SettleResult =
  | { ok: true; outcome: TransferOutcome; display: string }
  | SettleFailure;

/**
 * Send one amount from a custodial wallet we hold the key for.
 */
export async function settleTransfer(params: {
  sender: IUser;
  recipientAddress: string;
  token: ResolvedToken;
  /** Base units. */
  amount: bigint;
}): Promise<SettleResult> {
  const { sender, token, amount } = params;

  if (!sender.encryptedPrivateKey) {
    return { ok: false, reason: 'error', message: 'sender has no custodial key' };
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(await decryptPrivateKey(sender.encryptedPrivateKey));
  } catch {
    return { ok: false, reason: 'error', message: 'sender key could not be decrypted' };
  }

  const recipient = new PublicKey(params.recipientAddress);
  const display = formatAmount(amount, token.info);

  /* ------------------------------------------------------------- native SOL */
  if (!token.mint) {
    const balance = await getConnection().getBalance(keypair.publicKey, 'confirmed');
    const spendable = BigInt(spendableLamports(balance));

    if (amount > spendable) {
      return {
        ok: false,
        reason: 'insufficient',
        message: `not enough SOL: ${formatAmount(spendable, SOL)} available, ${display} requested`,
      };
    }

    // A transfer this small cannot leave the recipient's new account rent
    // exempt, so the runtime rejects it. Catching it here saves a wasted fee.
    if (amount < BigInt(ATA_RENT_LAMPORTS) / 2n) {
      const isNewAccount =
        (await getConnection().getBalance(recipient, 'confirmed')) === 0;
      if (isNewAccount) {
        return {
          ok: false,
          reason: 'dust',
          message: 'too small to open a new account on-chain',
        };
      }
    }

    return {
      ok: true,
      display,
      outcome: await transferLamports({
        from: keypair,
        to: recipient,
        lamports: Number(amount),
      }),
    };
  }

  /* -------------------------------------------------------------- SPL token */
  const held = await tokenBalance(keypair.publicKey, token.mint);
  if (held < amount) {
    return {
      ok: false,
      reason: 'insufficient',
      message: `not enough ${token.info.symbol}: ${formatAmount(held, token.info)} available, ${display} requested`,
    };
  }

  const needsAccount = await recipientNeedsAccount(recipient, token.mint);

  // The sender pays rent to open the recipient's token account. They must hold
  // enough SOL for that on top of the network fee, or the transaction fails
  // after we have already told them it is on its way.
  const lamports = await getConnection().getBalance(keypair.publicKey, 'confirmed');
  const required = (needsAccount ? ATA_RENT_LAMPORTS : 0) + 10_000;
  if (lamports < required) {
    return {
      ok: false,
      reason: 'insufficient',
      message: needsAccount
        ? `needs about ${(ATA_RENT_LAMPORTS / 1e9).toFixed(5)} SOL to open the recipient's ${token.info.symbol} account`
        : 'not enough SOL to cover the network fee',
    };
  }

  const plan = buildSplTransfer({
    from: keypair.publicKey,
    to: recipient,
    amount,
    resolved: token.mint,
    needsAccount,
  });

  return { ok: true, display, outcome: await sendInstructions(keypair, plan.instructions) };
}

/** Parse a human amount against a resolved token, surfacing a usable message. */
export function parseTokenAmount(
  amount: string,
  token: ResolvedToken
): { ok: true; base: bigint } | { ok: false; message: string } {
  try {
    return { ok: true, base: toBaseUnits(amount, token.info.decimals) };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
