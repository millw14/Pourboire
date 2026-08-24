/**
 * One place that talks to Solana.
 *
 * Every route used to build its own Connection, hand-roll a confirmation loop,
 * and guess 5000 lamports for the fee. Those loops reported "timeout" on a
 * transaction that had in fact been submitted and would land seconds later — the
 * caller then retried and sent the money twice. This module owns the transfer
 * lifecycle so that bug has exactly one place to live.
 */

import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { cluster, rpcUrl } from './env';
import { ValidationError } from './api';
import { solToLamports } from './lamports';

// The pure arithmetic lives in ./lamports so it can be tested without web3.js.
export {
  RENT_EXEMPT_RESERVE,
  FEE_RESERVE,
  spendableLamports,
  solToLamports,
  lamportsToSol,
} from './lamports';

let connection: Connection | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(rpcUrl(), 'confirmed');
  }
  return connection;
}

export function parseAmountSol(raw: unknown): number {
  const amount = typeof raw === 'string' ? Number(raw.trim()) : Number(raw);
  if (!Number.isFinite(amount)) throw new ValidationError('Enter a valid amount');
  if (amount <= 0) throw new ValidationError('Amount must be greater than zero');
  if (amount > 1_000_000) throw new ValidationError('That amount is too large');
  // Below one lamport the transfer is a no-op that still costs a fee.
  if (solToLamports(amount) < 1) throw new ValidationError('Amount is smaller than one lamport');
  return amount;
}

export function parsePublicKey(raw: unknown, label = 'address'): PublicKey {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ValidationError(`Enter a valid Solana ${label}`);
  }
  try {
    const key = new PublicKey(raw.trim());
    // PublicKey accepts 32 bytes that may not be a valid ed25519 point. Off-curve
    // keys are legitimate PDAs but cannot receive a plain transfer meaningfully
    // from a wallet's point of view, so reject them with a clear message.
    if (!PublicKey.isOnCurve(key.toBytes())) {
      throw new ValidationError(`That ${label} is a program address, not a wallet`);
    }
    return key;
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError(`That does not look like a Solana ${label}`);
  }
}

export type TransferOutcome =
  | { status: 'confirmed'; signature: string }
  | { status: 'failed'; signature: string; reason: string }
  /**
   * Submitted, but we stopped waiting before the network confirmed. The caller
   * MUST NOT retry — the transaction may still land. Surface the signature so the
   * user can watch it, and reconcile later.
   */
  | { status: 'unconfirmed'; signature: string };

/**
 * Send lamports from a keypair we hold, and wait for confirmation using the
 * blockhash's own validity window rather than an arbitrary wall-clock timeout.
 */
export async function transferLamports(params: {
  from: Keypair;
  to: PublicKey;
  lamports: number;
}): Promise<TransferOutcome> {
  const conn = getConnection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');

  const tx = new Transaction({
    feePayer: params.from.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(
    SystemProgram.transfer({
      fromPubkey: params.from.publicKey,
      toPubkey: params.to,
      lamports: params.lamports,
    })
  );
  tx.sign(params.from);

  const signature = await conn.sendRawTransaction(tx.serialize(), {
    // Preflight catches insufficient-funds and malformed transactions before
    // they cost anything. The old code disabled it to dodge blockhash expiry,
    // which traded a clear error for a silent failure.
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });

  return confirmSignature(signature, blockhash, lastValidBlockHeight);
}

/**
 * Wait for a submitted signature, using the blockhash's own validity window.
 *
 * Shared by the native and SPL paths so there is exactly one place that decides
 * what "we don't know yet" means. That distinction is the whole point: reporting
 * an unconfirmed transaction as failed is what makes a caller retry and send the
 * money twice.
 */
export async function confirmSignature(
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number
): Promise<TransferOutcome> {
  const conn = getConnection();
  try {
    const result = await conn.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    );
    if (result.value.err) {
      return { status: 'failed', signature, reason: JSON.stringify(result.value.err) };
    }
    return { status: 'confirmed', signature };
  } catch {
    // Timed out or the blockhash expired. Check once more before giving up —
    // the transaction may have landed between submission and the timeout.
    const status = await conn.getSignatureStatus(signature, { searchTransactionHistory: true });
    if (status.value?.err) {
      return { status: 'failed', signature, reason: JSON.stringify(status.value.err) };
    }
    if (
      status.value?.confirmationStatus === 'confirmed' ||
      status.value?.confirmationStatus === 'finalized'
    ) {
      return { status: 'confirmed', signature };
    }
    return { status: 'unconfirmed', signature };
  }
}

/**
 * A public randomness beacon: the blockhash of a recently finalised slot.
 *
 * Used to settle giveaways. Its value is unknowable when a giveaway commits to
 * its seed, and permanently checkable afterwards — anyone can query the slot and
 * confirm the hash. That is what makes the draw verifiable rather than trusted.
 *
 * Requires an RPC that serves `getBlock`; the public endpoints often do not, so
 * production needs a real provider.
 */
export async function fetchBeacon(): Promise<{ slot: number; hash: string }> {
  const conn = getConnection();
  const slot = await conn.getSlot('finalized');
  const block = await conn.getBlock(slot, {
    maxSupportedTransactionVersion: 0,
    transactionDetails: 'none',
    rewards: false,
  });
  if (!block?.blockhash) {
    throw new Error('Could not read a finalized block for the draw beacon');
  }
  return { slot, hash: block.blockhash };
}

export function explorerTxUrl(signature: string): string {
  const c = cluster();
  const suffix = c === 'mainnet-beta' ? '' : `?cluster=${c === 'devnet' ? 'devnet' : 'testnet'}`;
  return `https://solscan.io/tx/${signature}${suffix}`;
}

