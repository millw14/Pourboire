import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifiedSubjectFor,
  subjectMatchesCorridor,
  summariseVerification,
  type SubjectSource,
} from './subject.ts';

/**
 * Receiving needs no identity; paying out does. These tests guard that line.
 *
 * The type system already prevents forging a VerifiedSubject — there is one
 * constructor and it is this. What is testable is that the constructor refuses
 * everything it should, and that its refusals say something a person can act on.
 */

const verified: SubjectSource = {
  userId: 'u1',
  verifications: [{ provider: 'nium', status: 'verified', subjectRef: 'sub_123', country: 'NG' }],
};

test('a verified record yields a subject', () => {
  const result = verifiedSubjectFor(verified, 'nium');
  assert.ok(result.ok);
  assert.equal(result.subject.subjectRef, 'sub_123');
  assert.equal(result.subject.country, 'NG');
  assert.equal(result.subject.userId, 'u1');
});

test('a user who has never asked to cash out is unstarted, not an error', () => {
  // The overwhelmingly common case: a wallet was minted for a handle whose owner
  // has never heard of us. That is normal, so it must not read as a fault.
  const none = verifiedSubjectFor({ userId: 'u1' }, 'nium');
  assert.ok(!none.ok);
  assert.equal(none.status, 'unstarted');

  const empty = verifiedSubjectFor({ userId: 'u1', verifications: [] }, 'nium');
  assert.ok(!empty.ok);
  assert.equal(empty.status, 'unstarted');
});

test('verification with one provider does not verify another', () => {
  // Each provider does its own KYC and issues its own subject reference. Reusing
  // one across providers would send a payout with a reference the receiving
  // provider has never seen.
  const result = verifiedSubjectFor(verified, 'other');
  assert.ok(!result.ok);
  assert.equal(result.status, 'unstarted');
});

test('any status short of verified refuses', () => {
  for (const status of ['unstarted', 'pending', 'action_required', 'rejected'] as const) {
    const result = verifiedSubjectFor(
      {
        userId: 'u1',
        verifications: [{ provider: 'nium', status, subjectRef: 'sub', country: 'NG' }],
      },
      'nium'
    );
    assert.ok(!result.ok, status);
    assert.equal(result.status, status);
    assert.ok(result.message.length > 0);
  }
});

test('the provider reason is shown when there is one', () => {
  const result = verifiedSubjectFor(
    {
      userId: 'u1',
      verifications: [
        {
          provider: 'nium',
          status: 'action_required',
          reason: 'We need a clearer photo of your ID.',
        },
      ],
    },
    'nium'
  );
  assert.ok(!result.ok);
  assert.match(result.message, /clearer photo/);
});

test('verified with no subject reference refuses instead of paying blind', () => {
  // A provider-side inconsistency, not a user problem — but a payout with
  // nothing to attribute it to is worse than a delay.
  const result = verifiedSubjectFor(
    { userId: 'u1', verifications: [{ provider: 'nium', status: 'verified', country: 'NG' }] },
    'nium'
  );
  assert.ok(!result.ok);
  assert.equal(result.status, 'pending');
});

test('a country is required, and falls back to the profile before failing', () => {
  const withoutCountry: SubjectSource = {
    userId: 'u1',
    verifications: [{ provider: 'nium', status: 'verified', subjectRef: 'sub' }],
  };
  const missing = verifiedSubjectFor(withoutCountry, 'nium');
  assert.ok(!missing.ok);
  assert.equal(missing.status, 'action_required');

  const fallback = verifiedSubjectFor({ ...withoutCountry, payoutCountry: 'ke' }, 'nium');
  assert.ok(fallback.ok);
  assert.equal(fallback.subject.country, 'KE');
});

test('the verification country wins over the profile country', () => {
  // The provider verified them somewhere specific. A profile field they typed
  // themselves cannot move that.
  const result = verifiedSubjectFor({ ...verified, payoutCountry: 'BR' }, 'nium');
  assert.ok(result.ok);
  assert.equal(result.subject.country, 'NG');
});

test('a subject cannot be used on another country corridor', () => {
  const result = verifiedSubjectFor(verified, 'nium');
  assert.ok(result.ok);
  assert.ok(subjectMatchesCorridor(result.subject, 'NG'));
  assert.ok(subjectMatchesCorridor(result.subject, 'ng'));
  assert.ok(!subjectMatchesCorridor(result.subject, 'BR'));
});

test('the summary takes the most advanced status across providers', () => {
  assert.equal(summariseVerification(undefined), 'unstarted');
  assert.equal(summariseVerification([]), 'unstarted');
  assert.equal(
    summariseVerification([
      { provider: 'a', status: 'rejected' },
      { provider: 'b', status: 'verified' },
    ]),
    'verified'
  );
  assert.equal(
    summariseVerification([
      { provider: 'a', status: 'rejected' },
      { provider: 'b', status: 'pending' },
    ]),
    'pending'
  );
  // One rejection does not sink someone who is only part-way through elsewhere.
  assert.equal(
    summariseVerification([
      { provider: 'a', status: 'rejected' },
      { provider: 'b', status: 'action_required' },
    ]),
    'action_required'
  );
});

test('the summary is a display value and never unlocks a payout', () => {
  // Being verified with provider A must not let a payout run on provider B.
  // Only verifiedSubjectFor can authorise, and it is per provider.
  const source: SubjectSource = {
    userId: 'u1',
    verifications: [{ provider: 'a', status: 'verified', subjectRef: 's', country: 'NG' }],
  };
  assert.equal(summariseVerification(source.verifications), 'verified');
  assert.ok(!verifiedSubjectFor(source, 'b').ok);
});
