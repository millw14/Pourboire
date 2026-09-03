import { corridorKey, type Corridor } from './corridors.ts';
import type { CorridorCapability } from './capabilities.ts';

/**
 * Choosing which provider pays a given corridor.
 *
 * No single provider covers every market — coverage is regional, and "all
 * markets" is therefore a routing problem rather than a vendor choice. This is
 * the layer that makes adding a second or third provider a data change instead
 * of a rewrite.
 *
 * Pure and deterministic: the same table and the same inputs always produce the
 * same route, which is what makes a routing decision reconstructable during a
 * dispute.
 */

export type RouteFailure =
  /** Nobody declares this corridor at all. */
  | 'no_provider'
  /** Declared, but every provider covering it is switched off. */
  | 'provider_disabled'
  /** Declared, but settlement needs a chain we cannot send from yet. */
  | 'rail_unsupported'
  | 'below_minimum'
  | 'above_maximum'
  | 'country_blocked';

export type RouteResult =
  | { ok: true; route: CorridorCapability; alternates: readonly CorridorCapability[] }
  | { ok: false; reason: RouteFailure; message: string };

export interface RouteQuery {
  corridor: Corridor;
  /**
   * Minor units of the destination currency, or null to skip the limit check.
   *
   * Null is for the questions that are about a corridor rather than a payment —
   * adding a beneficiary, say. Without it, tokenising a bank account would be
   * refused for being below the minimum payout, which is nonsense.
   */
  amountMinor: bigint | null;
  table: readonly CorridorCapability[];
  /** Runtime disable overlay. A provider absent from this set is off. */
  enabled: ReadonlySet<string>;
  supportedRails: ReadonlySet<number>;
  blockedCountries?: ReadonlySet<string>;
}

/**
 * Resolve a corridor to a provider, or explain precisely why not.
 *
 * The failure reasons are distinct because they mean different things to the
 * person waiting: "we do not serve Nigeria" and "Nigeria is temporarily off" and
 * "that is below the minimum" deserve three different sentences, and a bare null
 * would collapse them into one shrug.
 */
export function resolveRoute(query: RouteQuery): RouteResult {
  const { corridor, amountMinor, table, enabled, supportedRails } = query;
  const key = corridorKey(corridor);

  if (query.blockedCountries?.has(corridor.country)) {
    return {
      ok: false,
      reason: 'country_blocked',
      message: `We cannot pay out to ${corridor.country}.`,
    };
  }

  const declared = table.filter((c) => corridorKey(c.corridor) === key);
  if (declared.length === 0) {
    return {
      ok: false,
      reason: 'no_provider',
      message: `We cannot pay out to ${corridor.country} in ${corridor.currency} yet.`,
    };
  }

  const live = declared.filter((c) => enabled.has(c.provider));
  if (live.length === 0) {
    return {
      ok: false,
      reason: 'provider_disabled',
      message: `Payouts to ${corridor.country} are temporarily unavailable.`,
    };
  }

  const settleable = live.filter((c) => supportedRails.has(c.rail.chainId));
  if (settleable.length === 0) {
    // Declared, funded, and still unreachable: the provider wants the stablecoin
    // on a chain we cannot send from. Saying so beats a generic failure.
    return {
      ok: false,
      reason: 'rail_unsupported',
      message: `Payouts to ${corridor.country} need a settlement route we have not built yet.`,
    };
  }

  const withinLimits =
    amountMinor === null
      ? settleable
      : settleable.filter(
          (c) =>
            amountMinor >= BigInt(c.limits.minMinor) && amountMinor <= BigInt(c.limits.maxMinor)
        );

  if (withinLimits.length === 0 && amountMinor !== null) {
    // Distinguish the two directions — telling someone "too small" when they
    // meant to send too much is worse than useless.
    const smallestMin = settleable.reduce(
      (min, c) => (BigInt(c.limits.minMinor) < min ? BigInt(c.limits.minMinor) : min),
      BigInt(settleable[0]!.limits.minMinor)
    );
    if (amountMinor < smallestMin) {
      return {
        ok: false,
        reason: 'below_minimum',
        message: `The smallest payout to ${corridor.country} is ${formatMinor(smallestMin, corridor.currency)}.`,
      };
    }
    const largestMax = settleable.reduce(
      (max, c) => (BigInt(c.limits.maxMinor) > max ? BigInt(c.limits.maxMinor) : max),
      BigInt(settleable[0]!.limits.maxMinor)
    );
    return {
      ok: false,
      reason: 'above_maximum',
      message: `The largest payout to ${corridor.country} is ${formatMinor(largestMax, corridor.currency)}.`,
    };
  }

  // Priority ascending, then provider name, so ties resolve identically on every
  // machine and in every replay.
  const ranked = [...withinLimits].sort(
    (a, b) => a.priority - b.priority || a.provider.localeCompare(b.provider)
  );

  return { ok: true, route: ranked[0]!, alternates: ranked.slice(1) };
}

/**
 * May a failed submission be retried against an alternate provider?
 *
 * Only before anything has moved. Once the stablecoin has been sent to provider
 * A's deposit address, failing over to provider B would leave the funds with A
 * while B is expected to pay — so the window closes at `quoted`, and the rail
 * must be byte-identical for the funds to be usable either way.
 */
export function mayFailOver(params: {
  status: string;
  refusalWasDefinite: boolean;
  current: CorridorCapability;
  alternate: CorridorCapability;
}): boolean {
  if (params.status !== 'quoted') return false;
  if (!params.refusalWasDefinite) return false;
  return sameRail(params.current, params.alternate);
}

function sameRail(a: CorridorCapability, b: CorridorCapability): boolean {
  return (
    a.rail.chainId === b.rail.chainId &&
    a.rail.tokenAddress.toLowerCase() === b.rail.tokenAddress.toLowerCase() &&
    (a.rail.depositAddress ?? '').toLowerCase() === (b.rail.depositAddress ?? '').toLowerCase()
  );
}

/** Minor units to a readable figure. Assumes two decimal places, as most currencies use. */
function formatMinor(minor: bigint, currency: string): string {
  const whole = minor / 100n;
  const cents = minor % 100n;
  return `${whole}.${cents.toString().padStart(2, '0')} ${currency}`;
}
