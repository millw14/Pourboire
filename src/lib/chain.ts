import 'server-only';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  encodeFunctionData,
  parseAbi,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { cluster, rpcUrl } from './env';

/**
 * Everything that talks to Robinhood Chain.
 *
 * Replaces the Solana money layer. The properties that mattered there still
 * matter here and are enforced in one place: a transfer either confirms, fails
 * cleanly, or comes back `unconfirmed` — never "timed out, please retry", which
 * is how you send the same money twice.
 */

/** Robinhood Chain: Arbitrum-stack L2, ~100ms blocks, ETH for gas. */
export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
});

export const robinhoodTestnet = defineChain({
  ...robinhoodChain,
  id: 46630,
  name: 'Robinhood Chain Testnet',
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
});

export function activeChain() {
  return cluster() === 'mainnet' ? robinhoodChain : robinhoodTestnet;
}

let publicClient: PublicClient | null = null;

export function getPublicClient(): PublicClient {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: activeChain(),
      transport: http(rpcUrl()),
    }) as PublicClient;
  }
  return publicClient;
}

export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/**
 * Gas held back so an account can still move what is left in it.
 *
 * On Solana this was rent exemption; here it is simply the cost of the next
 * transaction. An account drained to exactly zero is not destroyed the way a
 * Solana account is, but it is stranded — it cannot pay for the transfer that
 * would empty it. Same bug, different mechanism, same fix: never offer the whole
 * balance as spendable.
 */
const WEI_PER_ETH = 10n ** 18n;

/**
 * 0.0002 ETH, about twenty times the observed cost of a transfer on this chain
 * (~0.0000096 ETH at 0.23 gwei). Written as a division rather than a digit
 * literal on purpose: the first version of this line was `2_000_000_000_000_00n`
 * with a comment claiming 0.0001 ETH, and the misgrouped digits hid the fact
 * that it was twice that.
 */
export const GAS_RESERVE_WEI = WEI_PER_ETH / 5_000n;

/** A native-ETH transfer is 21000 gas; ERC-20 needs considerably more. */
const NATIVE_GAS_LIMIT = 21_000n;
const ERC20_GAS_LIMIT = 120_000n;

export function spendableWei(balanceWei: bigint): bigint {
  return balanceWei > GAS_RESERVE_WEI ? balanceWei - GAS_RESERVE_WEI : 0n;
}

export type TransferOutcome =
  /** Landed in a block and succeeded. */
  | { status: 'confirmed'; hash: Hex }
  /** Landed in a block and reverted. Nothing moved; safe to retry. */
  | { status: 'failed'; hash: Hex; reason: string }
  /**
   * The node refused it before accepting it — bad nonce, underpriced, rejected
   * by validation. It is definitely not in the mempool, so it is safe to retry.
   */
  | { status: 'rejected'; reason: string }
  /**
   * Broadcast, but not seen in a block before we stopped waiting. The caller
   * MUST NOT retry — it may still land. Surface the hash and reconcile later.
   */
  | { status: 'unconfirmed'; hash: Hex }
  /**
   * We do not know whether it was broadcast. The submission call itself failed
   * in a way that does not distinguish "never sent" from "sent, response lost".
   * Treated exactly like `unconfirmed`: never retried automatically.
   */
  | { status: 'unknown'; reason: string };

/**
 * Did the node refuse this outright, rather than the response going missing?
 *
 * Only errors that prove the transaction never entered the mempool belong here —
 * anything else has to be assumed in-flight. Getting this wrong in the
 * permissive direction is what causes a double send.
 */
function isDefiniteRejection(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('insufficient funds') ||
    m.includes('nonce too low') ||
    m.includes('already known') ||
    m.includes('replacement transaction underpriced') ||
    m.includes('intrinsic gas too low') ||
    m.includes('exceeds block gas limit')
  );
}

/** How long to wait for a receipt. Blocks are ~100ms, so this is generous. */
const CONFIRM_TIMEOUT_MS = 30_000;

/**
 * Broadcast one transaction and resolve it to a TransferOutcome.
 *
 * The single place that decides what a network failure means. Both plain
 * transfers and contract calls go through it, because getting this wrong in two
 * places is how the same money gets sent twice.
 *
 * Broadcast happens *inside* the try. viem's HTTP transport has a finite request
 * timeout, so if the response to eth_sendRawTransaction is lost after the
 * sequencer accepted it — a dropped socket, a 502 at the RPC edge — the call
 * rejects while the transaction is in the mempool and will land. Letting that
 * escape produced "something went wrong, please try again" for money that had
 * already moved, which is exactly the retry that double-sends. A rejection is
 * therefore `unknown`, not failure, unless the node explicitly refused it before
 * accepting.
 */
async function sendAndConfirm(
  privateKey: Hex,
  request: { to: Address; data?: Hex; value?: bigint; gas: bigint }
): Promise<TransferOutcome> {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: activeChain(), transport: http(rpcUrl()) });
  const pub = getPublicClient();

  let hash: Hex;
  try {
    hash = await wallet.sendTransaction(request);
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    if (isDefiniteRejection(message)) {
      return { status: 'rejected', reason: message };
    }
    return { status: 'unknown', reason: message };
  }

  try {
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: CONFIRM_TIMEOUT_MS });
    if (receipt.status !== 'success') {
      return { status: 'failed', hash, reason: 'reverted' };
    }
    return { status: 'confirmed', hash };
  } catch {
    // Timed out waiting. Check once more before giving up — it may have landed
    // between broadcast and the timeout.
    try {
      const receipt = await pub.getTransactionReceipt({ hash });
      if (receipt.status === 'success') return { status: 'confirmed', hash };
      return { status: 'failed', hash, reason: 'reverted' };
    } catch {
      return { status: 'unconfirmed', hash };
    }
  }
}

/**
 * Send native ETH or an ERC-20 from a custodial key.
 *
 * `token` of null means native ETH.
 */
export async function transfer(params: {
  privateKey: Hex;
  to: Address;
  amount: bigint;
  token: Address | null;
}): Promise<TransferOutcome> {
  return params.token
    ? sendAndConfirm(params.privateKey, {
        to: params.token,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [params.to, params.amount],
        }),
        gas: ERC20_GAS_LIMIT,
      })
    : sendAndConfirm(params.privateKey, {
        to: params.to,
        value: params.amount,
        gas: NATIVE_GAS_LIMIT,
      });
}

/**
 * Call a contract from a custodial key, with the same outcome discipline as a
 * transfer. Used by the swap path for `approve` and `exactInputSingle`.
 */
export async function sendCall(params: {
  privateKey: Hex;
  to: Address;
  data: Hex;
  gas: bigint;
  value?: bigint;
}): Promise<TransferOutcome> {
  return sendAndConfirm(params.privateKey, {
    to: params.to,
    data: params.data,
    gas: params.gas,
    ...(params.value !== undefined ? { value: params.value } : {}),
  });
}

/** Native ETH balance. */
export async function nativeBalance(address: Address): Promise<bigint> {
  return getPublicClient().getBalance({ address });
}

/** ERC-20 balance. Returns 0n for a contract that does not respond. */
export async function tokenBalance(token: Address, owner: Address): Promise<bigint> {
  try {
    return await getPublicClient().readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [owner],
    });
  } catch {
    return 0n;
  }
}

/**
 * Estimate what a transfer will cost in gas, so the sender can be told before
 * they are short rather than after the transaction reverts.
 */
export async function estimateFeeWei(isToken: boolean): Promise<bigint> {
  try {
    const gasPrice = await getPublicClient().getGasPrice();
    // Doubled: gas price on an L2 can move between estimate and inclusion, and
    // under-reserving strands the account.
    return gasPrice * (isToken ? ERC20_GAS_LIMIT : NATIVE_GAS_LIMIT) * 2n;
  } catch {
    return GAS_RESERVE_WEI;
  }
}

/**
 * Randomness for the giveaway draw, taken from a block nobody could have
 * predicted when the seed was committed.
 *
 * The block is read at a small lag rather than at the head: an L2 sequencer can
 * reorg its most recent blocks, and a beacon that changes afterwards makes the
 * published verification unreproducible.
 */
const BEACON_LAG_BLOCKS = 20n;

export async function fetchBeacon(): Promise<{ slot: number; hash: string }> {
  const client = getPublicClient();
  const head = await client.getBlockNumber();
  const target = head > BEACON_LAG_BLOCKS ? head - BEACON_LAG_BLOCKS : head;
  const block = await client.getBlock({ blockNumber: target });
  if (!block?.hash) {
    throw new Error('Could not read a block for the draw beacon');
  }
  return { slot: Number(block.number), hash: block.hash };
}

export function explorerTxUrl(hash: string): string {
  return `${activeChain().blockExplorers.default.url}/tx/${hash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${activeChain().blockExplorers.default.url}/address/${address}`;
}

/** `0x` + 40 hex characters, checked without pulling in a validator. */
export function isAddress(value: string): value is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/* -------------------------------------------------------------------------- */
/* Sign-then-broadcast, for payouts                                            */
/*                                                                             */
/* `transfer()` above learns a transaction's hash *from* the broadcast          */
/* response, which is exactly why `unknown` has to exist: a dropped socket      */
/* leaves a transaction that may be in the mempool and no identifier to look it */
/* up by. That is acceptable for a tip — the amounts are small and a stuck one  */
/* is triaged by hand — but not for a payout, where "we do not know" has to be  */
/* resolvable by a machine.                                                     */
/*                                                                             */
/* So a payout signs first. The hash and nonce are known before the network is  */
/* touched, they are written to the payout row, and only then is anything sent. */
/* `unknown` collapses into `unconfirmed`, and every indeterminate case becomes */
/* a receipt lookup rather than an operator's afternoon.                        */
/* -------------------------------------------------------------------------- */

export interface SignedTransfer {
  raw: Hex;
  hash: Hex;
  nonce: number;
  from: Address;
}

/**
 * Sign a transfer without broadcasting it.
 *
 * The nonce is read at `pending` so consecutive signatures do not collide, and
 * it is returned because the reconciler needs it: a chain nonce that has moved
 * past this one proves the transaction can never land.
 */
export async function signTransfer(params: {
  privateKey: Hex;
  to: Address;
  amount: bigint;
  token: Address | null;
}): Promise<SignedTransfer> {
  const account = privateKeyToAccount(params.privateKey);
  const wallet = createWalletClient({ account, chain: activeChain(), transport: http(rpcUrl()) });
  const pub = getPublicClient();

  const nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });

  const request = params.token
    ? {
        to: params.token,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'transfer' as const,
          args: [params.to, params.amount] as const,
        }),
        gas: ERC20_GAS_LIMIT,
      }
    : { to: params.to, value: params.amount, gas: NATIVE_GAS_LIMIT };

  const prepared = await wallet.prepareTransactionRequest({ ...request, nonce });
  const raw = await wallet.signTransaction(prepared as never);

  return {
    raw,
    // Derived from the bytes, not reported by the node — so it is known even if
    // the broadcast is never answered.
    hash: keccak256(raw),
    nonce,
    from: account.address,
  };
}

export type BroadcastOutcome =
  | { ok: true; hash: Hex }
  | { ok: false; definite: boolean; reason: string };

/**
 * Push already-signed bytes.
 *
 * Safe to call repeatedly with the same `raw`: identical bytes produce an
 * identical hash, so the chain deduplicates. `definite` says whether the node
 * refused it outright — the caller uses `classifyBroadcast` to turn that into a
 * state, because "already known" means opposite things on a first send and a
 * replay and only the caller knows which this is.
 */
export async function broadcastRaw(raw: Hex): Promise<BroadcastOutcome> {
  try {
    const hash = await getPublicClient().sendRawTransaction({ serializedTransaction: raw });
    return { ok: true, hash };
  } catch (e) {
    const reason = (e as Error)?.message ?? String(e);
    return { ok: false, definite: isDefiniteRejection(reason), reason };
  }
}

/** Whether a transaction has landed, and how. `missing` means no receipt yet. */
export async function receiptStatus(hash: Hex): Promise<'success' | 'reverted' | 'missing'> {
  try {
    const receipt = await getPublicClient().getTransactionReceipt({ hash });
    return receipt.status === 'success' ? 'success' : 'reverted';
  } catch {
    return 'missing';
  }
}

/**
 * The account's confirmed nonce.
 *
 * `latest`, deliberately, not `pending`: the reconciler compares this against a
 * signed transaction's nonce to decide whether that transaction is permanently
 * unincludable, and counting a pending transaction — possibly our own — would
 * make it declare a live payout dead.
 */
export async function nonceAt(address: Address): Promise<number> {
  return getPublicClient().getTransactionCount({ address, blockTag: 'latest' });
}
