/**
 * Proof that a person has been verified, in a form the compiler enforces.
 *
 * The product's central asymmetry is that **receiving needs no identity and
 * paying out does**. A tip can land for an X handle whose owner has never heard
 * of us — that is the whole mechanic, and it stays true. But no licensed
 * provider will move money into the banking system for an anonymous handle.
 *
 * That boundary used to be a comment in `User.ts` and a sentence in the UI.
 * Here it is a branded type with exactly one constructor, required by every
 * money-moving method on a provider. A route that forgets to check verification
 * does not compile, rather than failing in production against somebody's money.
 */

declare const brand: unique symbol;

export type VerificationStatus =
  | 'unstarted'
  | 'pending'
  | 'action_required'
  | 'verified'
  | 'rejected';

export interface VerificationRecord {
  provider: string;
  status: VerificationStatus;
  /** The provider's id for this person. What a payout actually references. */
  subjectRef?: string;
  /** ISO 3166-1 alpha-2. */
  country?: string;
  reason?: string;
}

export type VerifiedSubject = {
  readonly userId: string;
  readonly provider: string;
  readonly subjectRef: string;
  readonly country: string;
  readonly [brand]: 'VerifiedSubject';
};

export type SubjectResult =
  | { ok: true; subject: VerifiedSubject }
  | { ok: false; status: VerificationStatus; message: string };

export interface SubjectSource {
  userId: string;
  /** Absent on every user until they ask for fiat. */
  verifications?: readonly VerificationRecord[];
  /** Where they are being paid. Must agree with the corridor. */
  payoutCountry?: string;
}

/**
 * The only way to obtain a `VerifiedSubject`.
 *
 * Returns a result rather than throwing, so a route reads as a precondition
 * check and the caller is handed a message it can show verbatim.
 */
export function verifiedSubjectFor(source: SubjectSource, provider: string): SubjectResult {
  // An absent array is the normal case, not an error — nobody has a
  // verifications array until the first time they ask to cash out.
  const record = (source.verifications ?? []).find((v) => v.provider === provider);

  if (!record) {
    return {
      ok: false,
      status: 'unstarted',
      message: 'You need to verify your identity before you can cash out.',
    };
  }

  if (record.status !== 'verified') {
    return { ok: false, status: record.status, message: statusMessage(record) };
  }

  if (!record.subjectRef) {
    // Verified with no reference is a provider-side inconsistency, not a user
    // problem. Refuse rather than send a payout with nothing to attribute it to.
    return {
      ok: false,
      status: 'pending',
      message: 'Your verification is still being finalised. Try again shortly.',
    };
  }

  const country = record.country ?? source.payoutCountry;
  if (!country) {
    return {
      ok: false,
      status: 'action_required',
      message: 'Tell us which country you are being paid in.',
    };
  }

  return {
    ok: true,
    subject: {
      userId: source.userId,
      provider,
      subjectRef: record.subjectRef,
      country: country.toUpperCase(),
      // The brand is a type-level marker; nothing reads it at runtime.
    } as VerifiedSubject,
  };
}

/**
 * A verified subject may only be used on a corridor in the country they were
 * verified for. A Nigeria-verified person cannot be paid on a Brazil corridor
 * just because the caller passed one.
 */
export function subjectMatchesCorridor(subject: VerifiedSubject, country: string): boolean {
  return subject.country === country.toUpperCase();
}

function statusMessage(record: VerificationRecord): string {
  switch (record.status) {
    case 'pending':
      return 'Your identity check is still in progress.';
    case 'action_required':
      return record.reason ?? 'Your identity check needs something more from you.';
    case 'rejected':
      return record.reason ?? 'Your identity check was not accepted.';
    default:
      return 'You need to verify your identity before you can cash out.';
  }
}

/**
 * The single summary status shown in the UI, across however many providers.
 * Most advanced wins, so one verified provider is enough to unlock the flow.
 */
export function summariseVerification(
  records: readonly VerificationRecord[] | undefined
): VerificationStatus {
  if (!records || records.length === 0) return 'unstarted';
  const order: VerificationStatus[] = [
    'verified',
    'pending',
    'action_required',
    'rejected',
    'unstarted',
  ];
  for (const status of order) {
    if (records.some((r) => r.status === status)) return status;
  }
  return 'unstarted';
}
