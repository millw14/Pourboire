import { NextRequest } from 'next/server';
import connectDB from '@/lib/mongodb';
import { requireCaller } from '@/lib/auth';
import { check, fail, handleError, ok, rateLimit, tooManyRequests } from '@/lib/api';
import { resolveCallerUser } from '@/lib/wallets';
import PayoutDestination from '@/models/PayoutDestination';
import { resolvePayoutContext } from '@/lib/fiat/context';
import { corridorKey } from '@/lib/fiat/corridors';

/**
 * Tokenise a beneficiary.
 *
 * The only place in the app that ever sees an account number, and it does not
 * keep one: the fields go straight to the provider, which returns a reference,
 * and that reference plus a last-four is all that is written down. Someone who
 * stole this database would find nothing they could pay into.
 */

export async function GET(req: NextRequest) {
  try {
    const caller = await requireCaller(req);
    if (!rateLimit(`fiat-dest:${caller.privyUserId}`, 60, 60_000)) return tooManyRequests();

    await connectDB();
    const user = await resolveCallerUser(caller);
    check(user, 'No tip wallet found for your account');

    const rows = await PayoutDestination.find({
      userId: user._id,
      archivedAt: { $exists: false },
    })
      .sort({ createdAt: -1 })
      .lean();

    return ok({
      destinations: rows.map((d) => ({
        id: String(d._id),
        corridorKey: d.corridorKey,
        label: d.label,
        last4: d.last4,
        institution: d.institution,
      })),
    });
  } catch (e) {
    return handleError('fiat/destinations', e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const caller = await requireCaller(req);
    if (!rateLimit(`fiat-dest-add:${caller.privyUserId}`, 10, 60_000)) return tooManyRequests();

    await connectDB();
    const user = await resolveCallerUser(caller);
    check(user, 'No tip wallet found for your account');

    const body = await req.json().catch(() => ({}));
    const key = String(body.corridorKey ?? '');
    const label = String(body.label ?? '').trim().slice(0, 60);
    const fields = body.fields as Record<string, unknown> | undefined;

    check(label, 'Give this account a name so you can tell it apart');
    check(fields && typeof fields === 'object', 'Account details are required');

    // No amount: a beneficiary is not a payment, so payout limits do not apply.
    // Every other precondition — corridor, provider, identity, country — does.
    const context = resolvePayoutContext({ user, corridorKey: key, amountMinor: null });
    if (!context.ok) return fail(context.status, context.message, context.code);

    const missing = context.capability.requires.filter((f) => !String(fields?.[f] ?? '').trim());
    if (missing.length > 0) {
      return fail(400, `Missing: ${missing.join(', ')}`, 'missing_fields');
    }

    const stringFields = Object.fromEntries(
      context.capability.requires.map((f) => [f, String(fields?.[f]).trim()])
    );

    const created = await context.provider.createDestination({
      subject: context.subject,
      corridor: context.corridor,
      fields: stringFields,
    });

    // Upsert on the provider's reference: submitting the same account twice is
    // one row, so a double-clicked form cannot produce two identical
    // destinations to choose between.
    const doc = await PayoutDestination.findOneAndUpdate(
      { provider: context.provider.name, recipientRef: created.ref },
      {
        $set: { label, last4: created.last4 },
        $setOnInsert: {
          userId: user._id,
          provider: context.provider.name,
          corridorKey: corridorKey(context.corridor),
          recipientRef: created.ref,
        },
        $unset: { archivedAt: '' },
      },
      { upsert: true, new: true }
    );

    return ok({
      destination: {
        id: String(doc._id),
        corridorKey: doc.corridorKey,
        label: doc.label,
        last4: doc.last4,
      },
    });
  } catch (e) {
    return handleError('fiat/destinations', e);
  }
}
