import 'server-only';
import type { IUser } from '@/models/User';
import { parseCorridorKey, type Corridor } from './corridors.ts';
import { resolveRoute } from './routing.ts';
import { blockedCountries, enabledProviders, liveCapabilities, payoutProvider } from './registry';
import { SUPPORTED_RAIL_CHAIN_IDS, type CorridorCapability } from './capabilities.ts';
import { subjectMatchesCorridor, verifiedSubjectFor, type VerifiedSubject } from './subject.ts';
import type { PayoutProvider } from './types.ts';

/**
 * The preconditions every money-moving route shares, resolved once.
 *
 * Corridor, route, provider and — last, because it is the one the compiler
 * enforces — a `VerifiedSubject`. Gathering them here means a route reads as a
 * single guarded step rather than five nested checks, and a route that forgets
 * one cannot obtain a subject to pass on.
 */

export type ContextFailure = { ok: false; status: number; code: string; message: string };

export type PayoutContext = {
  ok: true;
  corridor: Corridor;
  capability: CorridorCapability;
  provider: PayoutProvider;
  subject: VerifiedSubject;
};

export function resolvePayoutContext(params: {
  user: IUser;
  corridorKey: string;
  amountMinor: bigint | null;
}): PayoutContext | ContextFailure {
  const corridor = parseCorridorKey(params.corridorKey);
  if (!corridor) {
    return { ok: false, status: 400, code: 'invalid_corridor', message: 'Unknown payout corridor' };
  }

  const route = resolveRoute({
    corridor,
    amountMinor: params.amountMinor,
    table: liveCapabilities(),
    enabled: enabledProviders(),
    supportedRails: SUPPORTED_RAIL_CHAIN_IDS,
    blockedCountries: blockedCountries(),
  });
  if (!route.ok) {
    // The routing layer already produced a sentence fit to show someone; passing
    // it through beats inventing a second, vaguer one here.
    return {
      ok: false,
      status: route.reason === 'no_provider' ? 503 : 400,
      code: route.reason,
      message: route.message,
    };
  }

  const provider = payoutProvider(route.route.provider);
  if (!provider) {
    return {
      ok: false,
      status: 503,
      code: 'provider_disabled',
      message: 'Payouts are temporarily unavailable.',
    };
  }

  const subject = verifiedSubjectFor(
    {
      userId: String(params.user._id),
      verifications: params.user.verifications,
      payoutCountry: params.user.payoutCountry,
    },
    provider.name
  );
  if (!subject.ok) {
    return { ok: false, status: 403, code: `verification_${subject.status}`, message: subject.message };
  }

  // Verified in Nigeria does not authorise a payout to Brazil, however the
  // caller addressed the request.
  if (!subjectMatchesCorridor(subject.subject, corridor.country)) {
    return {
      ok: false,
      status: 403,
      code: 'country_mismatch',
      message: `Your identity check was completed for a different country, so we cannot pay out to ${corridor.country}.`,
    };
  }

  return { ok: true, corridor, capability: route.route, provider, subject: subject.subject };
}
