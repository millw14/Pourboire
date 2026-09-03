import mongoose, { Document, Schema } from 'mongoose';

/**
 * One grant of gas to a user's custodial wallet.
 *
 * Two structural guarantees, both borrowed from patterns already load-bearing
 * elsewhere in this repo rather than invented here:
 *
 *  1. **One unresolved grant per user**, via a partial unique index on
 *     `{ userId, active }` — the same mechanism `Payout` uses for one open
 *     payout per user. Because that serialises everything per user, the
 *     per-user cap arithmetic is race-free without any atomic ceremony: two
 *     concurrent requests cannot both read "spent today" and both decide they
 *     fit.
 *  2. **A double-clicked button is one grant**, via a unique `requestKey`
 *     derived on the server — the same claim-by-unique-index that makes tip
 *     processing idempotent in `ProcessedTweet`.
 *
 * Like a payout, the transaction is signed before it is broadcast and the hash
 * is written first, so an indeterminate grant is something the reconciler can
 * look up rather than something a person has to reason about.
 */

export type SponsorshipStatus =
  /** Counters reserved, nothing signed. */
  | 'reserved'
  /** Signed and broadcast. */
  | 'sending'
  | 'confirmed'
  /** Definitively nothing left the sponsor wallet. Counters released. */
  | 'failed'
  /** Broadcast with no receipt. MUST NOT be re-sent; counters stay reserved. */
  | 'indeterminate';

export interface IGasSponsorship extends Document {
  userId: mongoose.Types.ObjectId;
  /** The recipient, copied from the user row — never from a request body. */
  wallet: string;
  intent: 'withdraw' | 'swap' | 'payout';
  status: SponsorshipStatus;
  /** Present only while unresolved, and always literally `true`. */
  active?: true;
  /** Server-derived. A retry of the same action is the same key. */
  requestKey: string;
  /** Wei granted, as a string: BigInt does not survive BSON. */
  amountWei: string;
  /** What the gas price was when the grant was sized, for later audit. */
  gasPriceWei: string;
  /** Written before broadcast, so an indeterminate grant is still findable. */
  txHash?: string;
  txNonce?: number;
  rawTx?: string;
  broadcastAt?: Date;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const GasSponsorshipSchema = new Schema<IGasSponsorship>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    wallet: { type: String, required: true, lowercase: true },
    intent: { type: String, enum: ['withdraw', 'swap', 'payout'], required: true },
    status: {
      type: String,
      enum: ['reserved', 'sending', 'confirmed', 'failed', 'indeterminate'],
      default: 'reserved',
      required: true,
    },
    // `true` or absent — never `false`. A partial index keyed on existence is
    // what makes "one unresolved grant" the database's problem rather than
    // something every caller has to remember to check.
    active: { type: Boolean },
    requestKey: { type: String, required: true, unique: true },
    amountWei: { type: String, required: true },
    gasPriceWei: { type: String, required: true },
    txHash: String,
    txNonce: Number,
    rawTx: String,
    broadcastAt: Date,
    note: String,
  },
  { timestamps: true }
);

// The lock. One unresolved grant per user, enforced by the database.
GasSponsorshipSchema.index(
  { userId: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true } }
);

// "What has this user been granted today, and ever?" — the per-user caps.
GasSponsorshipSchema.index({ userId: 1, createdAt: -1 });

// Operator queries: what is stuck, and what did we spend this week.
GasSponsorshipSchema.index({ status: 1, createdAt: -1 });

export default (mongoose.models.GasSponsorship as mongoose.Model<IGasSponsorship>) ||
  mongoose.model<IGasSponsorship>('GasSponsorship', GasSponsorshipSchema);
