import 'server-only';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  encodeFunctionData,
  parseAbi,
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
export const GAS_RESERVE_WEI = 2_000_000_000_000_00n; // 0.0001 ETH

/** A native-ETH transfer is 21000 gas; ERC-20 needs considerably more. */
const NATIVE_GAS_LIMIT = 21_000n;
const ERC20_GAS_LIMIT = 120_000n;

export function spendableWei(balanceWei: bigint): bigint {
  return balanceWei > GAS_RESERVE_WEI ? balanceWei - GAS_RESERVE_WEI : 0n;
}

export type TransferOutcome =
  | { status: 'confirmed'; hash: Hex }
  | { status: 'failed'; hash: Hex; reason: string }
  /**
   * Broadcast, but not seen in a block before we stopped waiting. The caller
   * MUST NOT retry — it may still land. Surface the hash and reconcile later.
   */
  | { status: 'unconfirmed'; hash: Hex };

/** How long to wait for a receipt. Blocks are ~100ms, so this is generous. */
const CONFIRM_TIMEOUT_MS = 30_000;

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
  const account = privateKeyToAccount(params.privateKey);
  const chain = activeChain();
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl()) });
  const pub = getPublicClient();

  const hash = params.token
    ? await wallet.sendTransaction({
        to: params.token,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [params.to, params.amount],
        }),
        gas: ERC20_GAS_LIMIT,
      })
    : await wallet.sendTransaction({
        to: params.to,
        value: params.amount,
        gas: NATIVE_GAS_LIMIT,
      });

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
