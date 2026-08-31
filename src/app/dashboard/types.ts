/** Shapes returned by `GET /api/me`, shared by the dashboard components. */

export interface HistoryItem {
  type: 'tip' | 'transfer';
  direction: 'in' | 'out';
  /** Pre-formatted by the server, e.g. "1.5 USDG" — the client never does decimal maths. */
  amount: string;
  rawAmount: string;
  token: string;
  counterparty: string;
  txHash: string;
  status: 'confirmed' | 'unconfirmed' | 'failed';
  date: string;
  explorerUrl?: string;
}

export interface PendingTip {
  id: string;
  amount: string;
  token: string;
  sender: string;
  tweetId: string;
  createdAt: string;
}

export interface Balance {
  symbol: string;
  /** Pre-formatted by the server, e.g. "12.5 USDG". */
  amount: string;
  /** Base units, for comparisons the client should not do in floating point. */
  raw: string;
  /** True for the native token, which pays gas rather than being tipped. */
  isGas: boolean;
}

export interface MeResponse {
  success: true;
  needsTwitter: boolean;
  cluster: 'mainnet' | 'testnet';
  user: {
    handle: string;
    name: string;
    profileImage: string;
    bio: string;
  } | null;
  wallet: {
    address: string;
    /**
     * Null when the RPC lookup failed — distinct from a genuinely empty wallet,
     * which is an empty array.
     */
    balances: Balance[] | null;
    balanceError: boolean;
  } | null;
  pending: PendingTip[];
  history: HistoryItem[];
  historyTruncated?: boolean;
}

export interface WithdrawResponse {
  success: true;
  status: 'confirmed' | 'unconfirmed';
  txHash: string;
  explorerUrl: string;
  amount?: number;
  to?: string;
  message?: string;
}
