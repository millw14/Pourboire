import { NextRequest } from 'next/server';
import connectDB from '@/lib/mongodb';
import { requireCaller } from '@/lib/auth';
import { check, fail, handleError, ok, rateLimit, tooManyRequests } from '@/lib/api';
import { resolveCallerUser } from '@/lib/wallets';
import User from '@/models/User';
import { identityProvider } from '@/lib/fiat/registry';
import { summariseVerification } from '@/lib/fiat/subject';

/**
 * Start or refresh an identity check.
 *
 * No identity document ever passes through this app. The provider runs a hosted
 * flow, we hold a status and a reference, and that is the whole of our
 * involvement — which is what keeps KYC scope where the licence is.
 *
 * Receiving a tip is unaffected by any of this. A wallet is still minted for an
 * X handle whose owner has never heard of us; verification is attached late, to
 * the people who ask for fiat, rather than standing in front of everyone.
 */

export async function POST(req: NextRequest) {
  try {
    const caller = await requireCaller(req);
    if (!rateLimit(`fiat-verify:${caller.privyUserId}`, 5, 60_000)) return tooManyRequests();

    await connectDB();
    const user = await resolveCallerUser(caller);
    check(user, 'No tip wallet found for your account');

    const body = await req.json().catch(() => ({}));
    const providerName = String(body.provider ?? '').trim();
    const country = String(body.country ?? '').trim().toUpperCase();

    const provider = providerName ? identityProvider(providerName) : null;
    if (!provider) {
      return fail(
        503,
        'Identity checks need a licensed partner. We are working on it.',
        'no_provider'
      );
    }
    if (country && !/^[A-Z]{2}$/.test(country)) {
      return fail(400, 'That is not a valid country code', 'invalid_country');
    }

    const session = await provider.startVerification({
      userId: String(user._id),
      handle: user.handle,
      country: country || undefined,
      returnUrl: new URL('/dashboard', req.nextUrl.origin).toString(),
    });

    // Upsert this provider's record in place, leaving any others alone —
    // verification does not transfer between providers.
    const existing = (user.verifications ?? []).filter((v) => v.provider !== provider.name);
    const verifications = [
      ...existing,
      {
        provider: provider.name,
        status: session.status,
        country: session.country ?? (country || undefined),
        reason: session.reason,
        updatedAt: new Date(),
      },
    ];

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          verifications,
          // The legacy summary the dashboard already reads.
          verification: {
            status: summariseVerification(verifications),
            provider: provider.name,
            providerRef: session.providerRef,
            reason: session.reason,
            updatedAt: new Date(),
          },
          ...(country ? { payoutCountry: country } : {}),
        },
      }
    );

    return ok({
      status: session.status,
      // The provider's own flow. We never collect documents ourselves.
      hostedUrl: session.hostedUrl ?? null,
      reason: session.reason,
    });
  } catch (e) {
    return handleError('fiat/verify', e);
  }
}
