/**
 * Which token a payout is allowed to spend.
 *
 * The approved plan excludes one thing by name: *"Auto-swapping equities to fund
 * a payout. Silently selling someone's NVDA because they pressed 'Cash out' is a
 * trade they did not authorise, at whatever slippage."*
 *
 * Until now that exclusion was a paragraph. Nothing enforced it, and the fiat
 * quote route takes its source token straight from the request body — so the
 * moment a real corridor is added, `{"token":"NVDA"}` would send somebody's
 * shares to a stablecoin deposit address and the provider would credit whatever
 * it felt like, or nothing.
 *
 * Two independent refusals, because they fail differently:
 *
 *  1. **Kind.** An equity is never a settlement asset, whatever the corridor
 *     says. This one produces the message a person needs: we are not selling
 *     your shares.
 *  2. **Identity with the rail.** Even among stablecoins, the only acceptable
 *     token is byte-identical to the one the provider declared. This is the
 *     allow-list, and it is what actually holds when a second stablecoin
 *     appears.
 *
 * Pure, so both are tested rather than reviewed.
 */

export interface SettlementCandidate {
  symbol: string;
  /** Null for native ETH. */
  address: string | null;
  kind: 'native' | 'stable' | 'equity' | 'meme';
}

export interface SettlementRailToken {
  tokenSymbol: string;
  tokenAddress: string;
}

export type SettlementRefusal =
  /** A tokenised share, fund or commodity. Selling it is a trade, not a payout. */
  | 'equity_not_settlement'
  /** ETH pays gas; spending it as the payout body strands the wallet. */
  | 'native_not_settlement'
  | 'meme_not_settlement'
  /** A stablecoin, but not the one this corridor settles in. */
  | 'wrong_settlement_token';

export type SettlementDecision =
  | { ok: true }
  | { ok: false; reason: SettlementRefusal; message: string };

export function checkSettlementToken(
  token: SettlementCandidate,
  rail: SettlementRailToken
): SettlementDecision {
  if (token.kind === 'equity') {
    return {
      ok: false,
      reason: 'equity_not_settlement',
      message: `We will not sell your ${token.symbol} to fund a payout. Swap it yourself first if that is what you want, then cash out the ${rail.tokenSymbol}.`,
    };
  }

  if (token.kind === 'native' || token.address === null) {
    return {
      ok: false,
      reason: 'native_not_settlement',
      message: 'ETH pays for gas on this chain and cannot be cashed out directly.',
    };
  }

  if (token.kind === 'meme') {
    return {
      ok: false,
      reason: 'meme_not_settlement',
      message: `We cannot cash out ${token.symbol}. Payouts settle in ${rail.tokenSymbol}.`,
    };
  }

  // A stablecoin still has to be THE stablecoin. Comparing addresses rather
  // than symbols, because a symbol is whatever a contract says it is and two
  // different contracts can both call themselves USDG.
  if (token.address.toLowerCase() !== rail.tokenAddress.toLowerCase()) {
    return {
      ok: false,
      reason: 'wrong_settlement_token',
      message: `This payout settles in ${rail.tokenSymbol}. Cash out ${rail.tokenSymbol} instead.`,
    };
  }

  return { ok: true };
}

/**
 * The cheap pre-check, for routes that have a token but not yet a corridor.
 *
 * Deliberately weaker than `checkSettlementToken` — it cannot know the rail, so
 * it only catches the categories that are wrong regardless of destination. The
 * real gate stays at the funding step.
 */
export function isNeverSettlement(kind: SettlementCandidate['kind']): boolean {
  return kind === 'equity' || kind === 'native' || kind === 'meme';
}
