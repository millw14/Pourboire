/**
 * Lamport arithmetic, with no dependencies.
 *
 * Kept separate from `solana.ts` so it can be unit-tested without pulling in
 * web3.js, Next's server runtime, or any environment configuration. This is the
 * code most likely to lose someone money if it regresses, so it should be the
 * easiest code in the repo to test.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * A System-Program account holding only lamports still owes rent exemption.
 * Draining below this makes the account reapable by the runtime.
 */
export const RENT_EXEMPT_RESERVE = 890_880;

/** Typical single-signature transfer fee, deliberately generous. */
export const FEE_RESERVE = 10_000;

/**
 * How much of a balance can actually be sent while leaving the account usable.
 *
 * This is the number a "Max" button must use. Comparing against the raw balance
 * instead — as the original withdraw route did — builds a transaction that
 * cannot pay its own fee, which then fails on-chain after the user has been told
 * it was fine.
 */
export function spendableLamports(balanceLamports: number): number {
  return Math.max(0, balanceLamports - RENT_EXEMPT_RESERVE - FEE_RESERVE);
}

/**
 * Rounds rather than truncating. `0.1 * 1e9` is 100000000.00000001 in IEEE-754
 * and neighbouring values land just below an integer, where `Math.floor`
 * silently drops a lamport.
 */
export function solToLamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL);
}

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}
