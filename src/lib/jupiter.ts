import 'server-only';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { getConnection, confirmSignature, type TransferOutcome } from './solana';
import { NATIVE_MINT } from './tokens';

/**
 * Swapping inside a tip wallet, via Jupiter.
 *
 * Deliberately **not** wired into the tip bot. Auto-swapping someone's SOL
 * because they tweeted "tip 100k BONK" would mean silently selling their
 * holdings at whatever slippage the route happens to carry — a side effect
 * nobody asked for, triggered by a tweet. Swaps only happen from the dashboard,
 * where the person sees the quote and presses the button.
 */

/**
 * Jupiter's free tier. Configurable because Jupiter has moved this host before
 * (`quote-api.jup.ag/v6` is retired), and a hardcoded endpoint that 404s is a
 * silent feature outage.
 */
const JUPITER_BASE = process.env.JUPITER_API_URL ?? 'https://lite-api.jup.ag/swap/v1';

/** Refuse anything worse than 5%, whatever the caller asks for. */
const MAX_SLIPPAGE_BPS = 500;

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  /** Base units. */
  inAmount: string;
  outAmount: string;
  /** Worst case after slippage, base units. */
  otherAmountThreshold: string;
  priceImpactPct: string;
  slippageBps: number;
  /** Opaque; must be handed back to the swap call unmodified. */
  raw: unknown;
}

function mintOf(mint: string | null): string {
  // Jupiter addresses native SOL by its wrapped mint.
  return mint ?? NATIVE_MINT;
}

export async function getQuote(params: {
  inputMint: string | null;
  outputMint: string | null;
  amount: bigint;
  slippageBps?: number;
}): Promise<SwapQuote> {
  const slippageBps = Math.min(params.slippageBps ?? 100, MAX_SLIPPAGE_BPS);

  const query = new URLSearchParams({
    inputMint: mintOf(params.inputMint),
    outputMint: mintOf(params.outputMint),
    amount: params.amount.toString(),
    slippageBps: String(slippageBps),
  });

  const res = await fetch(`${JUPITER_BASE}/quote?${query}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? 'No route found for that pair'
        : `Could not get a quote (${res.status})`
    );
  }

  const data = (await res.json()) as {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    otherAmountThreshold: string;
    priceImpactPct: string;
  };

  if (!data?.outAmount) throw new Error('No route found for that pair');

  return {
    inputMint: data.inputMint,
    outputMint: data.outputMint,
    inAmount: data.inAmount,
    outAmount: data.outAmount,
    otherAmountThreshold: data.otherAmountThreshold,
    priceImpactPct: data.priceImpactPct,
    slippageBps,
    raw: data,
  };
}

/**
 * Execute a previously fetched quote.
 *
 * The quote is passed back verbatim: re-fetching it here would mean the user
 * approved one price and got another.
 */
export async function executeSwap(params: {
  quote: SwapQuote;
  signer: Keypair;
}): Promise<TransferOutcome> {
  const res = await fetch(`${JUPITER_BASE}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: params.quote.raw,
      userPublicKey: params.signer.publicKey.toString(),
      // Lets the user swap to or from native SOL without managing a wrapped
      // account themselves.
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`Swap build failed (${res.status})`);

  const { swapTransaction } = (await res.json()) as { swapTransaction?: string };
  if (!swapTransaction) throw new Error('Swap build returned no transaction');

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([params.signer]);

  const conn = getConnection();
  const signature = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });

  // Jupiter builds against a recent blockhash; reuse it so confirmation waits
  // exactly as long as the transaction can actually land.
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  return confirmSignature(signature, blockhash, lastValidBlockHeight);
}
