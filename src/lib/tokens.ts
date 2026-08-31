/**
 * What can be tipped on Robinhood Chain.
 *
 * Every address here was read off the chain itself — `symbol()`, `decimals()`
 * and `name()` called against the live RPC — not copied from a listing site. A
 * wrong address in this file sends someone's money to the wrong contract, and a
 * wrong `decimals` is a factor-of-a-million error: USDG is 6 decimals while the
 * tokenised equities are 18.
 */

export interface TokenInfo {
  symbol: string;
  name: string;
  /** Contract address, or `null` for native ETH. */
  address: `0x${string}` | null;
  decimals: number;
  /** Accent colour on receipt cards. */
  color: string;
  /** Tokenised equities and commodities, shown differently from currencies. */
  kind: 'native' | 'stable' | 'equity' | 'meme';
}

export const KNOWN_TOKENS: readonly TokenInfo[] = [
  // The default. Paxos-issued, native to the chain, and the only one where a
  // tip is worth the same tomorrow — which is what makes cashing out coherent.
  {
    symbol: 'USDG',
    name: 'Global Dollar',
    address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    decimals: 6,
    color: '#00C805',
    kind: 'stable',
  },
  {
    symbol: 'ETH',
    name: 'Ether',
    address: null,
    decimals: 18,
    color: '#627EEA',
    kind: 'native',
  },
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
    decimals: 18,
    color: '#627EEA',
    kind: 'native',
  },

  // Tokenised equities. Tipping someone a share of NVIDIA is the thing this
  // chain can do that no other tipping bot can.
  {
    symbol: 'SPY',
    name: 'SPDR S&P 500 ETF',
    address: '0x117cc2133c37b721f49de2a7a74833232b3b4c0c',
    decimals: 18,
    color: '#1E88E5',
    kind: 'equity',
  },
  {
    symbol: 'NVDA',
    name: 'NVIDIA',
    address: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
    decimals: 18,
    color: '#76B900',
    kind: 'equity',
  },
  {
    symbol: 'GME',
    name: 'GameStop',
    address: '0x1b0e319c6a659f002271b69db8a7df2f911c153e',
    decimals: 18,
    color: '#E4002B',
    kind: 'equity',
  },
  {
    symbol: 'QQQ',
    name: 'Invesco QQQ',
    address: '0xd5f3879160bc7c32ebb4dc785f8a4f505888de68',
    decimals: 18,
    color: '#00A3E0',
    kind: 'equity',
  },
  {
    symbol: 'MSTR',
    name: 'Strategy Inc.',
    address: '0xec262a75e413fafd0df80480274532c79d42da09',
    decimals: 18,
    color: '#F7931A',
    kind: 'equity',
  },
  {
    symbol: 'GLD',
    name: 'SPDR Gold Trust',
    address: '0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e',
    decimals: 18,
    color: '#D4AF37',
    kind: 'equity',
  },
  {
    symbol: 'SPCX',
    name: 'SpaceX',
    address: '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea',
    decimals: 18,
    color: '#005288',
    kind: 'equity',
  },
] as const;

/** The default when a command names no token. */
export const DEFAULT_TOKEN: TokenInfo = KNOWN_TOKENS[0]!;
export const NATIVE: TokenInfo = KNOWN_TOKENS[1]!;

export const TIPPABLE_SYMBOLS: readonly string[] = [...KNOWN_TOKENS]
  .map((t) => t.symbol)
  // Longest first so the command regex prefers WETH over ETH.
  .sort((a, b) => b.length - a.length);

export function findTokenBySymbol(symbol: string): TokenInfo | null {
  const upper = symbol.toUpperCase();
  return KNOWN_TOKENS.find((t) => t.symbol.toUpperCase() === upper) ?? null;
}

export function findTokenByAddress(address: string): TokenInfo | null {
  const lower = address.toLowerCase();
  return KNOWN_TOKENS.find((t) => t.address?.toLowerCase() === lower) ?? null;
}

export function isNative(token: TokenInfo): boolean {
  return token.address === null;
}

/**
 * Decimal string to base units, by shifting the string.
 *
 * Never `amount * 10 ** decimals`: 0.29 * 1e18 is not an integer in IEEE-754,
 * and truncating the result silently underpays.
 */
export function toBaseUnits(amount: number | string, decimals: number): bigint {
  const text = String(amount).trim();
  if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') {
    throw new Error(`"${amount}" is not a number`);
  }

  const [whole = '0', fractionRaw = ''] = text.split('.');
  if (fractionRaw.length > decimals) {
    // Reject rather than round: silently discarding a digit of someone's money
    // is worse than telling them the amount is too precise.
    const trimmed = fractionRaw.replace(/0+$/, '');
    if (trimmed.length > decimals) {
      throw new Error(`too many decimal places — the most is ${decimals}`);
    }
  }
  const fraction = fractionRaw.slice(0, decimals).padEnd(decimals, '0');
  return BigInt(`${whole || '0'}${fraction || ''}`);
}

export function fromBaseUnits(base: bigint, decimals: number): string {
  const negative = base < 0n;
  const digits = (negative ? -base : base).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Human-readable, e.g. `1.5 ETH` or `250 USDG`. */
export function formatAmount(base: bigint, token: TokenInfo): string {
  const value = fromBaseUnits(base, token.decimals);
  const [whole = '0', fraction] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}${fraction ? `.${fraction}` : ''} ${token.symbol}`;
}

/**
 * Rebuild a token from what a stored history entry remembers about it.
 *
 * Records keep the symbol, address and decimals as they were at the time, so a
 * token that has since dropped off the registry still renders with the right
 * decimals — which is the difference between "1.5 USDG" and "1500000 USDG".
 */
export function tokenFromRecord(record: {
  tokenSymbol: string;
  tokenMint: string | null;
  tokenDecimals: number;
}): TokenInfo {
  return (
    findTokenBySymbol(record.tokenSymbol) ?? {
      symbol: record.tokenSymbol,
      name: record.tokenSymbol,
      address: record.tokenMint as `0x${string}` | null,
      decimals: record.tokenDecimals,
      color: '#8B8B8B',
      kind: 'meme',
    }
  );
}
