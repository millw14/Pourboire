import { NextRequest } from 'next/server';
import connectDB from '@/lib/mongodb';
import { requireCaller } from '@/lib/auth';
import { check, fail, handleError, ok, rateLimit, tooManyRequests } from '@/lib/api';
import { resolveCallerUser } from '@/lib/wallets';
import User from '@/models/User';
import { cardAvailability, cardProvider } from '@/lib/fiat/registry';
import { verifiedSubjectFor } from '@/lib/fiat/subject';

/**
 * Ask for a card.
 *
 * The app never sees a card number. The provider issues, the provider holds the
 * PAN, and what is stored here is a reference, a status and a last-four — so PCI
 * scope stays where the licence is. `detailsUrl` is proxied to the cardholder
 * and never cached, because caching it would put the details back in scope.
 */

export async function POST(req: NextRequest) {
  try {
    const caller = await requireCaller(req);
    if (!rateLimit(`fiat-card:${caller.privyUserId}`, 3, 60_000)) return tooManyRequests();

    await connectDB();
    const user = await resolveCallerUser(caller);
    check(user, 'No tip wallet found for your account');

    const provider = cardProvider();
    if (!provider) {
      const { reason } = cardAvailability();
      return fail(503, reason ?? 'Cards are not available yet.', 'no_provider');
    }

    if (user.card?.providerRef) {
      return ok({
        card: { status: user.card.status, last4: user.card.last4, brand: user.card.brand },
        message: 'You already have a card.',
      });
    }

    // The compile-time boundary in practice: without a verified subject there is
    // nothing to pass, so this route cannot issue a card to an unverified handle
    // even by mistake.
    const subject = verifiedSubjectFor(
      {
        userId: String(user._id),
        verifications: user.verifications,
        payoutCountry: user.payoutCountry,
      },
      provider.name
    );
    if (!subject.ok) {
      return fail(403, subject.message, `verification_${subject.status}`);
    }

    const card = await provider.issueCard({ subject: subject.subject });

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          card: {
            providerRef: card.providerRef,
            provider: provider.name,
            status: card.status,
            last4: card.last4,
            brand: card.brand,
            requestedAt: new Date(),
          },
        },
      }
    );

    return ok({
      card: { status: card.status, last4: card.last4, brand: card.brand },
      // A link, never the details themselves.
      detailsUrl: card.detailsUrl ?? null,
    });
  } catch (e) {
    return handleError('fiat/card', e);
  }
}
