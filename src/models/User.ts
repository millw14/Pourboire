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
  },
  { timestamps: true }
);

export default (mongoose.models.User as mongoose.Model<IUser>) ||
  mongoose.model<IUser>('User', UserSchema);
