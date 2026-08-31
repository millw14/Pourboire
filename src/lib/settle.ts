import 'server-only';
import type { Address, Hex } from 'viem';
import { decryptPrivateKey } from './crypto';
import {
  ERC20_ABI,
  estimateFeeWei,
  getPublicClient,
  isAddress,
  nativeBalance,
  spendableWei,
  tokenBalance,
  transfer,
  type TransferOutcome,
} from './chain';
import {
  NATIVE,
  findTokenByAddress,
  findTokenBySymbol,
  formatAmount,
  isNative,
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
}

/**
 * Turn a token as written in a tweet into something we can transfer.
 *
 * A known symbol resolves from the registry. Anything else must be a contract
 * address, which we read from the chain — we never guess a symbol for an unknown
 * contract, since a spoofed symbol is precisely how a scam token gets tipped.
 */
export async function resolveToken(token: string): Promise<ResolvedToken> {
  const known = findTokenBySymbol(token);
  if (known) return { info: known };

  if (!isAddress(token)) {
    throw new Error(`unknown token "${token}"`);
  }

  const listed = findTokenByAddress(token);
  if (listed) return { info: listed };

  // An address we have never seen. Read its identity off the chain rather than
  // trusting anything the tweet said about it.
  const client = getPublicClient();
  const [symbol, decimals, name] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }),
    client
      .readContract({ address: token, abi: ERC20_ABI, functionName: 'name' })
      .catch(() => 'Unknown token'),
  ]);

  return {
    info: {
      symbol: String(symbol),
      name: String(name),
      address: token,
      decimals: Number(decimals),
      color: '#8B8B8B',
      kind: 'meme',
    },
  };
}

export function parseTokenAmount(
  amount: string,
  token: ResolvedToken
): { ok: true; base: bigint } | { ok: false; message: string } {
  try {
    const base = toBaseUnits(amount, token.info.decimals);
    if (base <= 0n) return { ok: false, message: 'that amount is too small to send' };
    return { ok: true, base };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/**
 * Discriminated so a successful result narrows `outcome` to non-null — callers
 * cannot read a transaction hash off a transfer that never happened.
 */
export type SettleResult =
  | { ok: true; outcome: TransferOutcome }
  | { ok: false; message: string };

/**
 * Send `amount` of `token` from a user's custodial wallet.
 *
 * Every affordability check lives here. The sender pays gas in ETH regardless of
 * which token moves, which is the failure people hit first: you can hold a
 * thousand USDG and still be unable to send any of it.
 */
export async function settleTransfer(params: {
  sender: IUser;
  recipientAddress: string;
  amount: bigint;
  token: ResolvedToken;
}): Promise<SettleResult> {
  const { sender, token, amount } = params;

  if (!sender.encryptedPrivateKey || !sender.walletAddress) {
    return { ok: false, message: 'sender has no funded tip wallet' };
  }
  if (!isAddress(params.recipientAddress)) {
    return { ok: false, message: 'recipient address is not valid' };
  }

  const keyBytes = await decryptPrivateKey(sender.encryptedPrivateKey);
  const privateKey = `0x${Buffer.from(keyBytes).toString('hex')}` as Hex;
  const from = sender.walletAddress as Address;

  const native = isNative(token.info);
  const fee = await estimateFeeWei(!native);
  const ethBalance = await nativeBalance(from);

  if (native) {
    // One balance covers both the amount and the gas.
    if (amount + fee > ethBalance) {
      return { ok: false, message: `not enough ETH — ${formatAmount(spendableWei(ethBalance), NATIVE)} available after gas` };
    }
  } else {
    // Two separate balances, and running out of either stops the transfer.
    if (ethBalance < fee) {
      return { ok: false, message: 'not enough ETH to pay gas — top up a little ETH and try again' };
    }
    const held = await tokenBalance(token.info.address!, from);
    if (amount > held) {
      return { ok: false, message: `not enough ${token.info.symbol} — ${formatAmount(held, token.info)} available` };
    }
  }

  const outcome = await transfer({
    privateKey,
    to: params.recipientAddress as Address,
    amount,
    token: token.info.address,
  });

  return { ok: true, outcome };
}
