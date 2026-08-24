import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Provably-fair winner selection.
 *
 * Every giveaway on this platform is "trust me." This one is checkable by
 * anyone, and the property that makes it work is *ordering*:
 *
 *   1. **Commit.** When the giveaway opens we generate a secret `seed` and
 *      publish `sha256(seed)` in the announcement tweet. The seed itself stays
 *      hidden, so nobody — including us — can predict the draw yet.
 *
 *   2. **Beacon.** When the window closes we take the blockhash of a Solana slot
 *      produced *after* the deadline. Nobody knew that value at commit time, so
 *      we could not have chosen a seed that favours a particular entrant.
 *
 *   3. **Reveal.** We publish the seed, the slot, and its blockhash. Anyone can
 *      recompute `drawWinners` and get the same result, and can verify the
 *      committed hash matches the revealed seed.
 *
 * Neither party can cheat alone: we control the seed but not the beacon, and the
 * chain controls the beacon but never sees the seed. Grinding the beacon would
 * require rewriting Solana history.
 */

export interface DrawInput {
  /** Revealed secret. Hex. */
  seed: string;
  /** Blockhash of a slot produced after the entry window closed. */
  beacon: string;
  /**
   * Every eligible entry. Order does not matter — the function sorts before
   * shuffling so the result is reproducible from an unordered set.
   */
  entries: string[];
  winners: number;
}

export function generateSeed(): string {
  return randomBytes(32).toString('hex');
}

export function commitmentFor(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

export function verifyCommitment(seed: string, commitment: string): boolean {
  return commitmentFor(seed) === commitment;
}

/**
 * A deterministic stream of 32-bit values from (seed, beacon).
 *
 * HMAC in counter mode rather than repeated hashing: each block is independent,
 * so the sequence cannot be extended or rewound by anyone who learns one value.
 */
function* randomStream(seed: string, beacon: string): Generator<number> {
  let counter = 0;
  for (;;) {
    const block = createHmac('sha256', seed).update(`${beacon}:${counter}`).digest();
    for (let offset = 0; offset + 4 <= block.length; offset += 4) {
      yield block.readUInt32BE(offset);
    }
    counter += 1;
  }
}

/**
 * Uniform integer in [0, max) with rejection sampling.
 *
 * `value % max` would bias toward low indices whenever `max` does not divide
 * 2^32 — a small but real thumb on the scale, and exactly the kind of thing a
 * sceptical entrant is entitled to object to.
 */
function uniformBelow(stream: Generator<number>, max: number): number {
  const limit = Math.floor(0x100000000 / max) * max;
  for (;;) {
    const value = stream.next().value;
    if (value < limit) return value % max;
  }
}

/**
 * Pick `winners` distinct entries.
 *
 * Sorts first so callers need not preserve fetch order, then runs a partial
 * Fisher-Yates shuffle. Duplicate entries are collapsed beforehand: one reply
 * per person, no matter how many times they replied.
 */
export function drawWinners(input: DrawInput): string[] {
  const pool = [...new Set(input.entries)].sort();
  if (pool.length === 0) return [];

  const count = Math.min(input.winners, pool.length);
  const stream = randomStream(input.seed, input.beacon);

  for (let i = 0; i < count; i++) {
    const j = i + uniformBelow(stream, pool.length - i);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }

  return pool.slice(0, count);
}

/**
 * How the prize splits between winners, in base units.
 *
 * Integer division leaves a remainder that must go somewhere; it is distributed
 * one unit at a time to the earliest winners rather than being silently dropped.
 * Over many giveaways those stranded units would otherwise accumulate in the
 * sender's wallet, which is not what "5 SOL to 10 people" promises.
 */
export function splitPrize(total: bigint, winners: number): bigint[] {
  if (winners <= 0) return [];
  const base = total / BigInt(winners);
  const remainder = Number(total % BigInt(winners));
  return Array.from({ length: winners }, (_, i) => base + (i < remainder ? 1n : 0n));
}
