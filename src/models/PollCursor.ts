import mongoose, { Document, Schema } from 'mongoose';

/**
 * Where the mention poller got to.
 *
 * The old poller took `sinceId` from the request body, and the shell script that
 * drove it in production sent `{}` — so every run re-read the full seven-day
 * search window. Persisting the high-water mark server-side means the cursor
 * cannot be lost, forgotten, or overridden by a caller.
 */
export interface IPollCursor extends Document {
  key: string;
  sinceId?: string;
  lastRunAt?: Date;
  lastError?: string;
}

const PollCursorSchema = new Schema<IPollCursor>({
  key: { type: String, required: true, unique: true },
  sinceId: String,
  lastRunAt: Date,
  lastError: String,
});

export const MENTIONS_CURSOR = 'twitter:mentions';

export default (mongoose.models.PollCursor as mongoose.Model<IPollCursor>) ||
  mongoose.model<IPollCursor>('PollCursor', PollCursorSchema);
