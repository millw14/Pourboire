/** Shapes returned by `GET /api/me`, shared by the dashboard components. */

export interface HistoryItem {
  type: 'tip' | 'transfer';
  direction: 'in' | 'out';
  amount: number;
  token: 'SOL' | 'USDC';
  counterparty: string;
  txHash: string;
  status: 'confirmed' | 'unconfirmed' | 'failed';
  date: string;
  explorerUrl?: string;
}

export interface PendingTip {
  id: string;
  amount: number;
  token: 'SOL' | 'USDC';
  sender: string;
  tweetId: string;
  createdAt: string;
}

export interface MeResponse {
  success: true;
  needsTwitter: boolean;
  cluster: 'mainnet-beta' | 'devnet' | 'testnet';
  user: {
    handle: string;
    name: string;
    profileImage: string;
    bio: string;
  } | null;
  wallet: {
    address: string;
    /** `null` when the RPC lookup failed — distinct from a genuine zero balance. */
    balanceSol: number | null;
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
