import type { Corridor } from './corridors.ts';

/**
 * Which provider can pay into which corridor, declared as data.
 *
 * A static, reviewable table rather than runtime discovery. A routing decision
 * that changes silently under you cannot be tested, and cannot be reconstructed
 * six weeks later when someone disputes a payout. Runtime gets only a *disable*
 * overlay — never an enable — so the worst an env var can do is take a corridor
 * away.
 *
 * The table ships **empty**. No provider is contracted, so there is nothing
 * truthful to put in it. Publishing a corridor from a provider's marketing page,
 * before a single payout has been exercised against their live API, is the same
 * class of lie as a disabled button that looks enabled.
 */

/** Where a provider wants the stablecoin, for a given corridor. */
export interface SettlementRail {
  chainId: number;
  tokenSymbol: string;
  tokenAddress: string;
  /** Static deposit address, or null when the adapter mints one per payout. */
  depositAddress: string | null;
}

/** Fields a corridor needs before a recipient can be created. */
export type DestinationField =
  | 'accountNumber'
  | 'bankCode'
  | 'accountName'
  | 'phone'
  | 'pixKey'
  | 'clabe'
  | 'iban'
  | 'email';

export interface CorridorCapability {
  /** Matches `PayoutProvider.name`. */
  provider: string;
  corridor: Corridor;
  /**
   * Lower runs first. Explicit so that changing which provider serves a corridor
   * is a reviewable diff rather than an emergent property of a price auction.
   */
  priority: number;
  /** Minor units of the destination currency. */
  limits: { minMinor: string; maxMinor: string };
  requires: readonly DestinationField[];
  rail: SettlementRail;
  /** Shown as a range, never as a promise. */
  etaHours: readonly [number, number];
}

/**
 * Populated one corridor at a time, as each is actually exercised against a
 * live provider API — not in bulk from a coverage map.
 */
export const CAPABILITIES: readonly CorridorCapability[] = [];

/**
 * Chains we can settle on today.
 *
 * Robinhood Chain only. No provider settles USDG here, so in practice the first
 * real capability will name a different chain and route through
 * `rail_unsupported` until a bridge exists — which is the honest answer rather
 * than a half-built bridge to a chain the contract may not even use.
 */
export const SUPPORTED_RAIL_CHAIN_IDS: ReadonlySet<number> = new Set([4663, 46630]);
