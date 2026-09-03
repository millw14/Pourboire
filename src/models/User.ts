import mongoose, { Document, Schema } from 'mongoose';

export interface ITransaction {
  type: 'tip' | 'transfer';
  /** Direction relative to this user, so history can be read without guessing. */
  direction: 'in' | 'out';
  /** Base units, as a string: BigInt does not survive JSON or BSON. */
  amount: string;
  tokenSymbol: string;
  tokenMint: string | null;
  tokenDecimals: number;
  counterparty: string;
  txHash: string;
  /** `unconfirmed` means submitted but not observed on-chain — never retry these. */
  status: 'confirmed' | 'unconfirmed' | 'failed';
  date: Date;
}

export interface IPendingClaim {
  _id?: string;
  amount: string;
  tokenSymbol: string;
  tokenMint: string | null;
  tokenDecimals: number;
  /** The tweet the tip came from. */
  fromTx: string;
  sender: string;
  createdAt: Date;
}

export interface IUser extends Document {
  twitterId: string;
  /** Privy's user id, set once the person actually signs in. */
  privyUserId?: string;
  handle: string;
  name: string;
  profileImage: string;
  bio: string;
  walletAddress: string;
  encryptedPrivateKey?: string; // Only for custodial wallets
  isEmbedded: boolean;
  /** False until the real owner has signed in and claimed this pre-created record. */
  claimed: boolean;
  history: ITransaction[];
  pendingClaims: IPendingClaim[];
  /**
   * Identity, held only because fiat requires it.
   *
   * This is the line the product is built around: receiving a tip needs nothing
   * but an X handle, and that stays true. Turning a balance into local currency
   * or a card is money transmission, and no licensed provider will do it for an
   * anonymous handle. So verification is attached late, to the people who ask
   * for fiat, rather than being a wall in front of everyone.
   *
   * We hold a status and the provider's reference, never identity documents —
   * those go straight to the provider's hosted flow and never touch this app.
   */
  verification?: {
    status: 'unstarted' | 'pending' | 'action_required' | 'verified' | 'rejected';
    providerRef?: string;
    provider?: string;
    reason?: string;
    updatedAt?: Date;
  };
  /**
   * Per-provider verification.
   *
   * Verification does not transfer between providers: each does its own KYC and
   * issues its own subject reference, and a payout sent with another provider's
   * reference means nothing to the one being asked to pay. `verification` above
   * stays as the derived summary the dashboard already reads.
   *
   * Absent on every existing document, which is the normal case rather than a
   * migration problem — nobody has one until the first time they ask to cash
   * out. `verifiedSubjectFor` is written to treat absence as `unstarted`.
   */
  verifications?: {
    provider: string;
    status: 'unstarted' | 'pending' | 'action_required' | 'verified' | 'rejected';
    /** The provider's id for this person. What a payout actually references. */
    subjectRef?: string;
    /** ISO 3166-1 alpha-2, as established by the provider. */
    country?: string;
    reason?: string;
    updatedAt?: Date;
  }[];
  /** Preferred local currency, for display. Not a payout instruction. */
  preferredCurrency?: string;
  /**
   * Where this person is paid, when the provider has not established it itself.
   * A fallback for the corridor check, never an override — see `subject.ts`.
   */
  payoutCountry?: string;
  /** Reference to a card issued by the provider. Never card data itself. */
  card?: {
    providerRef: string;
    provider: string;
    status: 'pending' | 'active' | 'frozen' | 'closed';
    last4?: string;
    brand?: string;
    requestedAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const TransactionSchema = new Schema<ITransaction>(
  {
    type: { type: String, enum: ['tip', 'transfer'], required: true },
    direction: { type: String, enum: ['in', 'out'], required: true },
    amount: { type: String, required: true },
    tokenSymbol: { type: String, required: true },
    tokenMint: { type: String, default: null },
    tokenDecimals: { type: Number, required: true },
    counterparty: { type: String, required: true },
    txHash: { type: String, required: true },
    status: {
      type: String,
      enum: ['confirmed', 'unconfirmed', 'failed'],
      default: 'confirmed',
    },
    date: { type: Date, default: Date.now },
  },
  { _id: true }
);

const PendingClaimSchema = new Schema<IPendingClaim>({
  amount: { type: String, required: true },
  tokenSymbol: { type: String, required: true },
  tokenMint: { type: String, default: null },
  tokenDecimals: { type: Number, required: true },
  fromTx: { type: String, required: true },
  sender: { type: String, required: true },
  // Without this the dashboard had nothing to show but "now" for every claim.
  createdAt: { type: Date, default: Date.now },
});

const UserSchema = new Schema<IUser>(
  {
    // `unique` already builds an index; the old code also called schema.index()
    // for each of these, so Mongoose warned about duplicates on every boot.
    twitterId: { type: String, required: true, unique: true },
    privyUserId: { type: String, unique: true, sparse: true },
    handle: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    profileImage: { type: String, default: '' },
    bio: { type: String, default: '' },
    // `sparse` matters: twitter-callback used to write '' here, and a second such
    // user collided on the unique index and failed to save.
    walletAddress: { type: String, unique: true, sparse: true },
    encryptedPrivateKey: { type: String },
    isEmbedded: { type: Boolean, default: false },
    claimed: { type: Boolean, default: false },
    history: [TransactionSchema],
    pendingClaims: [PendingClaimSchema],

    // Identity and card state. Deliberately references only — no identity
    // documents and no card data are stored here, because holding either would
    // pull this app into PCI and KYC scope it has no business being in.
    verification: {
      status: {
        type: String,
        enum: ['unstarted', 'pending', 'action_required', 'verified', 'rejected'],
        default: 'unstarted',
      },
      providerRef: String,
      provider: String,
      reason: String,
      updatedAt: Date,
    },
    verifications: {
      type: [
        new Schema(
          {
            provider: { type: String, required: true },
            status: {
              type: String,
              enum: ['unstarted', 'pending', 'action_required', 'verified', 'rejected'],
              required: true,
            },
            subjectRef: String,
            country: String,
            reason: String,
            updatedAt: Date,
          },
          { _id: false }
        ),
      ],
      // No default. An absent array and an empty one mean the same thing to
      // `verifiedSubjectFor`, and defaulting would rewrite every document for
      // no gain.
      required: false,
    },
    preferredCurrency: String,
    payoutCountry: String,
    card: {
      providerRef: String,
      provider: String,
      status: { type: String, enum: ['pending', 'active', 'frozen', 'closed'] },
      last4: String,
      brand: String,
      requestedAt: Date,
    },
  },
  { timestamps: true }
);

export default (mongoose.models.User as mongoose.Model<IUser>) ||
  mongoose.model<IUser>('User', UserSchema);
