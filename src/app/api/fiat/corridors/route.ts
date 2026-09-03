import { NextRequest } from 'next/server';
import { requireCaller } from '@/lib/auth';
import { handleError, ok, rateLimit, tooManyRequests } from '@/lib/api';
import { blockedCountries, liveCapabilities, payoutAvailability } from '@/lib/fiat/registry';
import { corridorKey, METHOD_LABELS } from '@/lib/fiat/corridors';

/**
 * Where money can actually be sent, right now.
 *
 * Derived from the capability table, which is populated one corridor at a time
 * as each is exercised against a live provider API — so an empty list here means
 * exactly what it says, rather than a loading state or a bug.
 */

export async function GET(req: NextRequest) {
  try {
    const caller = await requireCaller(req);
    if (!rateLimit(`fiat-corridors:${caller.privyUserId}`, 60, 60_000)) return tooManyRequests();

    const blocked = blockedCountries();

    return ok({
      ...payoutAvailability(),
      corridors: liveCapabilities()
        .filter((c) => !blocked.has(c.corridor.country))
        .map((c) => ({
          key: corridorKey(c.corridor),
          country: c.corridor.country,
          currency: c.corridor.currency,
          method: c.corridor.method,
          methodLabel: METHOD_LABELS[c.corridor.method],
          minMinor: c.limits.minMinor,
          maxMinor: c.limits.maxMinor,
          // What a destination form has to collect. The values go to the
          // provider and are never stored here.
          requires: c.requires,
          etaHours: c.etaHours,
        })),
    });
  } catch (e) {
    return handleError('fiat/corridors', e);
  }
}
