import 'server-only';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import { getConnection, type TransferOutcome, confirmSignature } from './solana';
import { ATA_RENT_LAMPORTS, type TokenInfo, findTokenByMint } from './tokens';

/**
 * Sending tokens that are not SOL.
 *
 * Two things make this harder than a lamport transfer, and both cost real money
 * if ignored:
 *
 *  1. A recipient who has never held the token has no account to receive it.
 *     One must be created, and the *sender* pays its rent (~0.00204 SOL).
 *  2. Mints can live under either the original Token program or Token-2022.
 *     Using the wrong program id makes the instruction fail.
 */

export interface ResolvedMint {
  mint: PublicKey;
  decimals: number;
  programId: PublicKey;
  /** Registry entry when we know this token, otherwise a synthetic one. */
  info: TokenInfo;
}

/** Read a mint's decimals and owning program straight from the chain. */
export async function resolveMint(mintAddress: string): Promise<ResolvedMint> {
  const conn = getConnection();
  const mint = new PublicKey(mintAddress);

  const account = await conn.getAccountInfo(mint, 'confirmed');
  if (!account) throw new Error('That mint does not exist on this cluster');

  const programId = account.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  if (!account.owner.equals(TOKEN_PROGRAM_ID) && !account.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error('That address is not a token mint');
  }

  const mintInfo = await getMint(conn, mint, 'confirmed', programId);
  const known = findTokenByMint(mintAddress);

  return {
    mint,
    decimals: mintInfo.decimals,
    programId,
    info: known ?? {
      // Unknown mints are addressed by their address; we do not invent a symbol
      // for them, because a symbol is exactly what a scam token would spoof.
      symbol: `${mintAddress.slice(0, 4)}…${mintAddress.slice(-4)}`,
      name: 'Unknown token',
      mint: mintAddress,
      decimals: mintInfo.decimals,
      color: '#8B8B8B',
    },
  };
}

/** Base-unit balance of `owner`'s associated account for this mint. */
export async function tokenBalance(owner: PublicKey, resolved: ResolvedMint): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(
    resolved.mint,
    owner,
    /* allowOwnerOffCurve */ false,
    resolved.programId
  );
  try {
    const account = await getAccount(getConnection(), ata, 'confirmed', resolved.programId);
    return account.amount;
  } catch {
    // No account means no balance, which is not an error.
    return 0n;
  }
}

/** Whether the recipient already has somewhere to receive this token. */
export async function recipientNeedsAccount(
  recipient: PublicKey,
  resolved: ResolvedMint
): Promise<boolean> {
  const ata = getAssociatedTokenAddressSync(resolved.mint, recipient, false, resolved.programId);
  const info = await getConnection().getAccountInfo(ata, 'confirmed');
  return info === null;
}

export interface SplTransferPlan {
  instructions: TransactionInstruction[];
  /** Lamports the sender pays on top of the network fee, for account rent. */
  extraLamports: number;
}

/**
 * Build the instructions to move `amount` base units from `from` to `to`.
 *
 * Uses the *idempotent* create instruction so two concurrent transfers to the
 * same new recipient cannot fail each other — the second simply becomes a no-op
 * rather than reverting the whole transaction.
 */
export function buildSplTransfer(params: {
  from: PublicKey;
  to: PublicKey;
  amount: bigint;
  resolved: ResolvedMint;
  needsAccount: boolean;
}): SplTransferPlan {
  const { from, to, amount, resolved, needsAccount } = params;

  const fromAta = getAssociatedTokenAddressSync(resolved.mint, from, false, resolved.programId);
  const toAta = getAssociatedTokenAddressSync(resolved.mint, to, false, resolved.programId);

  const instructions: TransactionInstruction[] = [];

  if (needsAccount) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        from, // payer
        toAta,
        to, // owner
        resolved.mint,
        resolved.programId
      )
    );
  }

  instructions.push(
    // `TransferChecked` rather than `Transfer`: it verifies the decimals on
    // chain, so a mismatch between our idea of the token and the mint's fails
    // the transaction instead of moving the wrong amount.
    createTransferCheckedInstruction(
      fromAta,
      resolved.mint,
      toAta,
      from,
      amount,
      resolved.decimals,
      [],
      resolved.programId
    )
  );

  return {
    instructions,
    extraLamports: needsAccount ? ATA_RENT_LAMPORTS : 0,
  };
}

/** Send a prepared set of instructions from a keypair we hold. */
export async function sendInstructions(
  from: Keypair,
  instructions: TransactionInstruction[]
): Promise<TransferOutcome> {
  const conn = getConnection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');

  const tx = new Transaction({
    feePayer: from.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(...instructions);
  tx.sign(from);

  const signature = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });

  return confirmSignature(signature, blockhash, lastValidBlockHeight);
}

/** Convenience for a batch of native SOL payouts in a single transaction. */
export function buildSolPayouts(
  from: PublicKey,
  payouts: Array<{ to: PublicKey; lamports: number }>
): TransactionInstruction[] {
  return payouts.map(({ to, lamports }) =>
    SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports })
  );
}
