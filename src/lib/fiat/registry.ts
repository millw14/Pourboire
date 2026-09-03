import 'server-only';
import { CAPABILITIES, SUPPORTED_RAIL_CHAIN_IDS } from './capabilities.ts';
import type { CardProvider, IdentityProvider, PayoutProvider } from './types.ts';

/**
 * Which providers exist, and which are switched on.
 *
 * Deliberately returns nothing rather than falling back to a stub in
 * production: a stub that issues fake card numbers or reports fake payouts is
 * worse than an unavailable feature, because it looks like it worked. That was
 * true of the single `activeProvider()` this replaces and is still the rule.
 *
 * The env var is a **disable overlay only**. There is no way to switch a
 * provider on from configuration — an adapter has to be constructed here, in
 * checked-in code, which means a reviewable diff. The worst a misconfigured
 * environment can do is take a corridor away.
 */

const registered: {
  payout: PayoutProvider[];
  card: CardProvider[];
  identity: IdentityProvider[];
} = {
  // Constructed here when a provider is contracted — e.g.
  // `if (process.env.NIUM_API_KEY) payout.push(new NiumPayoutProvider(...))`.
  payout: [],
  card: [],
  identity: [],
};

/** Provider names disabled at runtime, from `FIAT_DISABLED_PROVIDERS`. */
function disabledProviders(): ReadonlySet<string> {
  return new Set(
    (process.env.FIAT_DISABLED_PROVIDERS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** Countries we will not pay out to, from `FIAT_BLOCKED_COUNTRIES`. */
export function blockedCountries(): ReadonlySet<string> {
  return new Set(
    (process.env.FIAT_BLOCKED_COUNTRIES ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

/** Provider names currently live. Feeds `resolveRoute`'s `enabled` set. */
export function enabledProviders(): ReadonlySet<string> {
  const off = disabledProviders();
  return new Set(registered.payout.map((p) => p.name).filter((n) => !off.has(n.toLowerCase())));
}

export function payoutProvider(name: string): PayoutProvider | null {
  if (disabledProviders().has(name.toLowerCase())) return null;
  return registered.payout.find((p) => p.name === name) ?? null;
}

export function identityProvider(name: string): IdentityProvider | null {
  if (disabledProviders().has(name.toLowerCase())) return null;
  return registered.identity.find((p) => p.name === name) ?? null;
}

export function cardProvider(): CardProvider | null {
  const off = disabledProviders();
  return registered.card.find((p) => !off.has(p.name.toLowerCase())) ?? null;
}

/** The corridors that could route right now, after the disable overlay. */
export function liveCapabilities() {
  const enabled = enabledProviders();
  return CAPABILITIES.filter(
    (c) => enabled.has(c.provider) && SUPPORTED_RAIL_CHAIN_IDS.has(c.rail.chainId)
  );
}

export interface Availability {
  available: boolean;
  /** A real explanation, never a shrug. Shown verbatim. */
  reason?: string;
}

export function payoutAvailability(): Availability {
  if (registered.payout.length === 0) {
    return {
      available: false,
      reason:
        'Cashing out to a bank account needs a licensed payout partner. We are working on it.',
    };
  }
  if (liveCapabilities().length === 0) {
    // A provider exists but no corridor it serves is settleable from a chain we
    // can send on. Worth distinguishing, because it is a bridge problem rather
    // than a contract one.
    return {
      available: false,
      reason: 'Payouts are temporarily unavailable while we finish a settlement route.',
    };
  }
  return { available: true };
}

export function cardAvailability(): Availability {
  return cardProvider()
    ? { available: true }
    : { available: false, reason: 'Cards need a licensed issuer. We are working on it.' };
}

/** Is any part of the fiat side live? Drives the UI's gating. */
export function fiatEnabled(): boolean {
  return payoutAvailability().available || cardAvailability().available;
}
