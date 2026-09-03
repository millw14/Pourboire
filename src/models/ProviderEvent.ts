import mongoose, { Document, Schema } from 'mongoose';

/**
 * A webhook we have already seen.
 *
 * Webhooks here carry **no state**. The handler verifies the signature, claims
 * the event id by inserting into this collection, extracts only the object id,
 * discards every status and amount in the body, and then reads the truth from
 * the provider's API. Replay, reordering, and even a leaked signing secret all
 * become non-events, because the body is never believed.
 *
 * It also means the system works with webhooks switched off entirely — which is
 * the only way to exercise any of this before a contract exists.
 *
 * The unique index is the claim, exactly as `ProcessedTweet.tweetId` is for
 * mentions: first insert wins, duplicates are skipped rather than reprocessed.
 */

export interface IProviderEvent extends Document {
  provider: string;
  eventId: string;
  /** What kind of object it pointed at, for triage. Not trusted for decisions. */
  objectType?: string;
  objectRef?: string;
  createdAt: Date;
}

const ProviderEventSchema = new Schema<IProviderEvent>(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    objectType: String,
    objectRef: String,
    // TTL below keys on this, so it is set explicitly rather than by timestamps.
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

ProviderEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

// Ninety days. Long enough that no plausible replay window is open, short
// enough that this never becomes a large collection.
ProviderEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export default (mongoose.models.ProviderEvent as mongoose.Model<IProviderEvent>) ||
  mongoose.model<IProviderEvent>('ProviderEvent', ProviderEventSchema);
