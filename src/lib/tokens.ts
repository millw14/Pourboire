/**
 * Which tokens can be tipped, and how to talk about amounts in them.
 *
 * SOL is nine decimals and everything else is not, so every amount that crosses
 * a boundary — a tweet, the database, a transaction — has to carry its decimals
 * with it. Getting this wrong sends 1000x the intended amount, so conversion
 * lives here and nowhere else.
 */

export const NATIVE_MINT = 'So11111111111111111111111111111111111111112';

export interface TokenInfo {
  symbol: string;
  name: string;
  /** Mint address, or `null` for native SOL. */
  mint: string | null;
  decimals: number;
  /** Shown on receipt cards. */
  color: string;
}

/**
 * Curated list. Deliberately not the full Jupiter token list: that is hundreds
 * of thousands of entries, most of them scams sharing a symbol with something
 * real. A tip command naming a symbol resolves only against this list; anything
 * else must be tipped by explicit mint address, where the sender has already
 * decided which token they mean.
 */
export const KNOWN_TOKENS: readonly TokenInfo[] = [
  { symbol: 'SOL', name: 'Solana', mint: null, decimals: 9, color: '#14F195' },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    color: '#2775CA',
  },
  {
    symbol: 'USDT',
    name: 'Tether',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    decimals: 6,
    color: '#26A17B',
  },
  {
    symbol: 'BONK',
    name: 'Bonk',
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    decimals: 5,
    color: '#F5A623',
  },
  {
    symbol: 'JUP',
    name: 'Jupiter',
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    decimals: 6,
    color: '#00BEF0',
  },
  {
    symbol: 'WIF',
    name: 'dogwifhat',
    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    decimals: 6,
    color: '#C4A484',
  },
  {
    symbol: 'JTO',
    name: 'Jito',
    mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
    decimals: 9,
    color: '#3AC5C9',
  },
  {
    symbol: 'PYTH',
    name: 'Pyth Network',
    mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
    decimals: 6,
    color: '#7142CF',
  },
] as const;

export const SOL: TokenInfo = KNOWN_TOKENS[0];

/** The symbols the tip parser will accept, longest first so `USDC` beats `USD`. */
export const TIPPABLE_SYMBOLS: readonly string[] = [...KNOWN_TOKENS]
  .map((t) => t.symbol)
  .sort((a, b) => b.length - a.length);

export function findTokenBySymbol(symbol: string): TokenInfo | null {
  const upper = symbol.trim().toUpperCase();
  return KNOWN_TOKENS.find((t) => t.symbol === upper) ?? null;
}

export function findTokenByMint(mint: string): TokenInfo | null {
  return KNOWN_TOKENS.find((t) => t.mint === mint) ?? null;
}

export function isNative(token: { mint: string | null }): boolean {
  return token.mint === null;
}

/**
 * Convert a human amount to base units.
 *
 * Done as a decimal-string shift rather than `amount * 10 ** decimals`, because
 * floating point multiplication loses precision at exactly the magnitudes people
 * tip: `0.29 * 1e9` is 289999999.99999994, and truncating that quietly
 * underpays. String shifting is exact for every input a human can type.
 */
export function toBaseUnits(amount: number | string, decimals: number): bigint {
  const raw = typeof amount === 'number' ? amount.toFixed(decimals) : amount.trim();

  if (!/^\d*\.?\d*$/.test(raw) || raw === '' || raw === '.') {
    throw new Error(`Invalid amount: ${raw}`);
  }

  const [whole = '0', fraction = ''] = raw.split('.');
  if (fraction.length > decimals) {
    // More precision than the token has. Refuse rather than silently rounding
    // someone's amount to something they did not type.
    throw new Error(`That token only supports ${decimals} decimal places`);
  }

  const padded = fraction.padEnd(decimals, '0');
  return BigInt(`${whole}${padded}` || '0');
}

/** Inverse of `toBaseUnits`, with trailing zeros trimmed. */
export function fromBaseUnits(base: bigint, decimals: number): string {
  const negative = base < 0n;
  const digits = (negative ? -base : base).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Human-readable, e.g. `1.5 SOL` or `100,000 BONK`. */
export function formatAmount(base: bigint, token: TokenInfo): string {
  const value = fromBaseUnits(base, token.decimals);
  const [whole = '0', fraction] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}${fraction ? `.${fraction}` : ''} ${token.symbol}`;
}

/**
 * Rent for an associated token account, which the sender pays the first time
 * they send an SPL token to someone who has never held it. Real money, so the
 * bot says so rather than letting the transaction fail or silently cost more.
 */
export const ATA_RENT_LAMPORTS = 2_039_280;
