import mongoose, { Document, Schema } from 'mongoose';

/**
 * A beneficiary, as a reference rather than as bank details.
 *
 * Account numbers are posted once to the provider, exchanged for a token, and
 * dropped. Nothing here would be useful to somebody who stole the database:
 * `last4` and a label the user chose, so they can tell two accounts apart.
 *
 * The reason is not squeamishness. Storing full account details pulls this app
 * into a compliance scope it has no licence for, and it is the provider — who
 * does have one — that has to hold them anyway.
 */

export interface IPayoutDestination extends Document {
  userId: mongoose.Types.ObjectId;
  provider: string;
  /** `NG:bank:NGN`. A destination belongs to exactly one corridor. */
  corridorKey: string;
  /** The provider's token for this beneficiary. What a payout references. */
  recipientRef: string;
  /** What the user calls it. */
  label: string;
  /** For telling two accounts apart, and nothing more. */
  last4?: string;
  /** Bank or wallet name, as returned by the provider. Never an account number. */
  institution?: string;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PayoutDestinationSchema = new Schema<IPayoutDestination>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: String, required: true },
    corridorKey: { type: String, required: true },
    recipientRef: { type: String, required: true },
    label: { type: String, required: true },
    last4: String,
    institution: String,
    // Archived rather than deleted: a settled payout must still be explicable
    // six weeks later, and that means the beneficiary it named still resolving.
    archivedAt: Date,
  },
  { timestamps: true }
);

// The same beneficiary tokenised twice by the same provider is one row, so a
// double-submitted form cannot produce two identical destinations to choose
// between.
PayoutDestinationSchema.index({ provider: 1, recipientRef: 1 }, { unique: true });

// The list a user picks from.
PayoutDestinationSchema.index({ userId: 1, corridorKey: 1, createdAt: -1 });

export default (mongoose.models.PayoutDestination as mongoose.Model<IPayoutDestination>) ||
  mongoose.model<IPayoutDestination>('PayoutDestination', PayoutDestinationSchema);
