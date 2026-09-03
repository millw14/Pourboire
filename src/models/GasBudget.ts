import mongoose, { Document, Schema } from 'mongoose';

/**
 * The global daily gas budget: one document per UTC day.
 *
 * The per-user caps are already race-free, because the one-unresolved-grant lock
 * on `GasSponsorship` serialises a single user's requests. The global cap is the
 * one number with genuine cross-user contention, and it is the only thing that
 * bounds a fleet of Sybil accounts — so it cannot be a read-then-write.
 *
 * It is reserved with a single filtered `findOneAndUpdate` + `$inc` + `upsert`.
 * The filter carries the cap, so a document that would exceed it simply does not
 * match: no read, no compare, and no window between them. A miss IS the refusal.
 *
 * Deliberately not a Mongo transaction. This is Mongoose against Atlas, and a
 * single-document atomic update needs no replica-set ceremony to be correct.
 *
 * Denominated in **gwei, as a Number**, unlike every other amount in this
 * codebase — because `$inc` cannot operate on the strings wei amounts are
 * normally stored as. Gwei keeps a generous daily cap far below 2^53
 * (0.05 ETH is 50,000,000 gwei), and reservations round up, so the rounding can
 * only ever spend the budget faster than reality rather than slower.
 */

export interface IGasBudget extends Document<string> {
  /** `gas:YYYY-MM-DD`, UTC. */
  _id: string;
  spentGwei: number;
  updatedAt: Date;
}

const GasBudgetSchema = new Schema<IGasBudget>(
  {
    _id: { type: String, required: true },
    spentGwei: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, _id: false }
);

export default (mongoose.models.GasBudget as mongoose.Model<IGasBudget>) ||
  mongoose.model<IGasBudget>('GasBudget', GasBudgetSchema);
