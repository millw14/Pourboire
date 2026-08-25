import mongoose, { Document, Schema } from 'mongoose';

/**
 * A giveaway, from commitment through to payout.
 *
 * The fields exist in the order the protocol needs them: `seedCommitment` is
 * published immediately and `seed` stays hidden until the draw, because a seed
 * revealed early would let anyone predict the winners.
 */

export type GiveawayStatus =
  /** Announced, entries open, seed committed but not revealed. */
  | 'open'
  /** Window closed, winners drawn, payout not yet confirmed. */
  | 'drawn'
  /** Winners paid and verifiable. */
  | 'settled'
  /** Ended without a payout — no entries, or the creator could not fund it. */
  | 'void';

export interface IGiveawayWinner {
  handle: string;
  walletAddress: string;
  /** Base units of the prize token. */
  amount: string;
}

export interface IGiveaway extends Document {
  /** The tweet that announced it; also the conversation entries are drawn from. */
  tweetId: string;
  creatorHandle: string;

  /** Total prize in base units, stored as a string to survive JSON and BSON. */
  totalAmount: string;
  tokenSymbol: string;
  tokenMint: string | null;
  tokenDecimals: number;

  winnerCount: number;
  closesAt: Date;

  /** Published at announcement. */
  seedCommitment: string;
  /** Withheld until the draw. */
  seed?: string;

  /** Solana slot whose blockhash seeded the draw, and that blockhash. */
  beaconSlot?: number;
  beaconHash?: string;

  /** Every eligible entry, in the order used for the draw. */
  entries: string[];
  winners: IGiveawayWinner[];

  status: GiveawayStatus;
  payoutTxHashes: string[];
  note?: string;

  createdAt: Date;
  updatedAt: Date;
}

const WinnerSchema = new Schema<IGiveawayWinner>(
  {
    handle: { type: String, required: true },
    walletAddress: { type: String, required: true },
    amount: { type: String, required: true },
  },
  { _id: false }
);

const GiveawaySchema = new Schema<IGiveaway>(
  {
    tweetId: { type: String, required: true, unique: true },
    creatorHandle: { type: String, required: true, lowercase: true },

    totalAmount: { type: String, required: true },
    tokenSymbol: { type: String, required: true },
    tokenMint: { type: String, default: null },
    tokenDecimals: { type: Number, required: true },

    winnerCount: { type: Number, required: true },
    closesAt: { type: Date, required: true },

    seedCommitment: { type: String, required: true },
    seed: { type: String },

    beaconSlot: { type: Number },
    beaconHash: { type: String },

    entries: { type: [String], default: [] },
    winners: { type: [WinnerSchema], default: [] },

    status: {
      type: String,
      enum: ['open', 'drawn', 'settled', 'void'],
      default: 'open',
    },
    payoutTxHashes: { type: [String], default: [] },
    note: { type: String },
  },
  { timestamps: true }
);

// The sweeper's query: which open giveaways are now due?
GiveawaySchema.index({ status: 1, closesAt: 1 });
GiveawaySchema.index({ creatorHandle: 1, createdAt: -1 });

export default (mongoose.models.Giveaway as mongoose.Model<IGiveaway>) ||
  mongoose.model<IGiveaway>('Giveaway', GiveawaySchema);
