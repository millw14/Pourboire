import mongoose, { Document, Schema } from 'mongoose';
import { ALL_STATUSES, type PayoutStatus } from '@/lib/fiat/payout-state';

/**
 * One attempt to turn a stablecoin balance into local money.
 *
 * Two structural idempotency mechanisms, both borrowed from what already works
 * in `ProcessedTweet`:
 *
 *  1. **Compare-and-swap on every transition.** Status changes go through
 *     `updateOne({ _id, status: from }, ...)` and check `matchedCount`. Never
 *     read-modify-write — that is how two workers both decide a payout is ready
 *     to fund.
 *  2. **One active payout per user.** A partial unique index on
 *     `{ userId, active }` solves the double-clicked button, two quotes racing,
 *     and two individually-affordable payouts that are not jointly affordable,
 *     all at once. It also makes the idempotency key derivable rather than
 *     client-supplied.
 *
 * The funding fields are written **before** the transaction is broadcast. That
 * is the whole point of signing locally first: if the socket dies during
 * `eth_sendRawTransaction`, the hash and nonce are already on disk, so the
 * reconciler knows exactly what to look for. Without them a dropped connection
 * leaves money that may or may not have moved and no way to find out.
 */

export interface IPayout extends Document {
  userId: mongoose.Types.ObjectId;
  status: PayoutStatus;
  /**
   * Present only while the payout is live, and always the literal `true`.
   * Combined with a partial unique index this permits exactly one open payout
   * per user; it is unset (not set to false) on reaching a terminal state.
   */
  active?: true;

  provider: string;
  /** `NG:bank:NGN`. Compared against the routing table without normalising. */
  corridorKey: string;

  /** Derived, never accepted from a client: `${provider}:${quoteId}`. */
  idemKey: string;
  quoteId: string;
  quoteExpiresAt: Date;

  /** Stablecoin leaving the wallet, in base units. */
  sourceAmount: string;
  sourceToken: string;
  /**
   * What the quote promised, in minor units. Kept separate from what actually
   * settled — a provider paying a different amount than it quoted is a fact
   * worth being able to see rather than overwrite.
   */
  quotedDestinationMinor: string;
  settledDestinationMinor?: string;
  feeMinor?: string;

  /** The provider's tokenised beneficiary. Never an account number. */
  destinationRef: string;

  /** Written before broadcast. All three, or the reconciler is blind. */
  /** The address that signed it, so the reconciler can read its nonce. */
  fundingFrom?: string;
  fundingHash?: string;
  fundingNonce?: number;
  fundingRawTx?: string;
  fundingBroadcastAt?: Date;

  providerRef?: string;
  /** Why it stands where it does, for the person waiting and the operator. */
  note?: string;
  /** Set when automation has given up and a human must look. */
  escalatedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const PayoutSchema = new Schema<IPayout>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ALL_STATUSES as string[], default: 'quoted', required: true },
    // Deliberately `true` or absent — never `false`. A partial index keyed on
    // existence is what makes "one active payout" enforceable by the database
    // rather than by remembering to check.
    active: { type: Boolean },

    provider: { type: String, required: true },
    corridorKey: { type: String, required: true },

    idemKey: { type: String, required: true, unique: true },
    quoteId: { type: String, required: true },
    quoteExpiresAt: { type: Date, required: true },

    sourceAmount: { type: String, required: true },
    sourceToken: { type: String, required: true },
    quotedDestinationMinor: { type: String, required: true },
    settledDestinationMinor: String,
    feeMinor: String,

    destinationRef: { type: String, required: true },

    fundingFrom: String,
    fundingHash: String,
    fundingNonce: Number,
    // The signed bytes, kept so a retry can rebroadcast the *identical*
    // transaction. Re-signing produces a second nonce and is the double-send.
    fundingRawTx: String,
    fundingBroadcastAt: Date,

    providerRef: String,
    note: String,
    escalatedAt: Date,
  },
  { timestamps: true }
);

// One open payout per user. Partial rather than sparse so that only documents
// actually carrying `active` participate.
PayoutSchema.index(
  { userId: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true } }
);

// Operator query: "what is stuck?", oldest first.
PayoutSchema.index({ status: 1, createdAt: -1 });

// The reconciler's scan: frozen payouts ordered by how long they have been that
// way.
PayoutSchema.index({ status: 1, fundingBroadcastAt: 1 });

export default (mongoose.models.Payout as mongoose.Model<IPayout>) ||
  mongoose.model<IPayout>('Payout', PayoutSchema);
