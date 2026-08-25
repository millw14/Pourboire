import mongoose, { Document, Schema } from 'mongoose';

/**
 * The ledger that makes tip processing idempotent.
 *
 * Without it the poller re-read the same seven-day mention window on every run
 * and re-sent SOL for tips that had already settled. A unique index on `tweetId`
 * turns "have we paid this tweet?" into an atomic insert: the first caller wins,
 * every subsequent caller gets a duplicate-key error and skips.
 *
 * The claim is taken BEFORE any transfer is attempted. Losing a tip to a crash is
 * recoverable by hand; sending it twice is not.
 */

export type TweetStatus =
  /** Claimed by a poll run; no transfer attempted yet. */
  | 'claimed'
  /** Transfer confirmed on-chain. */
  | 'settled'
  /** Submitted but never observed. MUST NOT be retried — it may still land. */
  | 'unconfirmed'
  /** Nothing was broadcast. Safe to release for another attempt. */
  | 'failed'
  /** Parsed but not payable yet (e.g. sender has no funded wallet). */
  | 'pending';

export interface IProcessedTweet extends Document {
  tweetId: string;
  status: TweetStatus;
  senderHandle?: string;
  recipientHandle?: string;
  /** Human amount as written in the tweet. */
  amount?: string;
  /** Symbol or raw mint, as written. */
  token?: string;
  txHash?: string;
  /** Why it is not settled, for operator triage. */
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ProcessedTweetSchema = new Schema<IProcessedTweet>(
  {
    tweetId: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ['claimed', 'settled', 'unconfirmed', 'failed', 'pending'],
      default: 'claimed',
    },
    senderHandle: String,
    recipientHandle: String,
    amount: String,
    token: String,
    txHash: String,
    note: String,
  },
  { timestamps: true }
);

// Operator queries: "what is stuck?" ordered by age.
ProcessedTweetSchema.index({ status: 1, createdAt: -1 });

export default (mongoose.models.ProcessedTweet as mongoose.Model<IProcessedTweet>) ||
  mongoose.model<IProcessedTweet>('ProcessedTweet', ProcessedTweetSchema);
