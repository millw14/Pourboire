import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSponsorKey, sponsorConfigured } from './key.ts';

const VALID = '0x' + 'a1'.repeat(32);

test('a well-formed key parses', () => {
  const r = parseSponsorKey(VALID);
  assert.ok(r.ok);
  assert.equal(r.key, VALID);
});

test('an absent key is not an error', () => {
  // A deployment without sponsorship configured is a valid deployment — it just
  // behaves the way it did before this feature existed.
  for (const raw of [undefined, null, '', '   ']) {
    const r = parseSponsorKey(raw);
    assert.ok(!r.ok);
    assert.equal(r.reason, 'absent', JSON.stringify(raw));
  }
});

test('a malformed key is distinguished from an absent one', () => {
  // They need different responses: absent means "this is off", malformed means
  // "somebody made a mistake and should be told".
  for (const raw of [
    'a1'.repeat(32), // no 0x
    '0x' + 'a1'.repeat(31), // too short
    '0x' + 'a1'.repeat(33), // too long
    '0x' + 'zz'.repeat(32), // not hex
    '0x' + '0'.repeat(64), // all zeroes
  ]) {
    const r = parseSponsorKey(raw);
    assert.ok(!r.ok, raw.slice(0, 12));
    assert.equal(r.reason, 'malformed', raw.slice(0, 12));
  }
});

test('surrounding whitespace and casing are tolerated', () => {
  // Both are what happens when a key is pasted out of a password manager.
  assert.ok(parseSponsorKey(`  ${VALID}  `).ok);
  assert.ok(parseSponsorKey(VALID.toUpperCase().replace('0X', '0x')).ok);
});

test('a rejection never quotes the key', () => {
  // The single most important property here. An error message is going to end
  // up in a log, and a private key in a log is a compromised wallet.
  const secret = '0x' + 'de'.repeat(31);
  const r = parseSponsorKey(secret);
  assert.ok(!r.ok);
  assert.ok(r.reason === 'malformed' && !r.detail.includes('de'.repeat(4)), r.reason === 'malformed' ? r.detail : '');
});

test('configured is exactly parseability', () => {
  assert.ok(sponsorConfigured(VALID));
  assert.ok(!sponsorConfigured(undefined));
  assert.ok(!sponsorConfigured('nonsense'));
});
