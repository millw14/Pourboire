import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  corridorKey,
  parseCorridorKey,
  isWellFormed,
  PAYOUT_METHODS,
  METHOD_LABELS,
  type Corridor,
} from './corridors.ts';

/**
 * A corridor key is written into payout rows and compared against a routing
 * table. If the two sides ever normalise differently, a payout routes to the
 * wrong provider or to none — so round-tripping is the property that matters.
 */

test('the key is the canonical form', () => {
  assert.equal(corridorKey({ country: 'NG', method: 'bank', currency: 'NGN' }), 'NG:bank:NGN');
});

test('case is normalised on the way in, so stored keys always match', () => {
  const key = corridorKey({ country: 'ng', method: 'bank', currency: 'ngn' });
  assert.equal(key, 'NG:bank:NGN');
  assert.equal(corridorKey({ country: 'Ng', method: 'bank', currency: 'nGn' }), key);
});

test('every corridor round-trips through its key', () => {
  for (const method of PAYOUT_METHODS) {
    const corridor: Corridor = { country: 'BR', method, currency: 'BRL' };
    assert.deepEqual(parseCorridorKey(corridorKey(corridor)), corridor);
  }
});

test('malformed keys parse to null rather than a plausible-looking corridor', () => {
  // A silently-wrong corridor routes money somewhere nobody chose.
  for (const key of [
    '',
    'NG',
    'NG:bank',
    'NG:bank:NGN:extra',
    'NGA:bank:NGN',
    'NG:bank:NG',
    'NG:carrier_pigeon:NGN',
    'N1:bank:NGN',
    ':::',
  ]) {
    assert.equal(parseCorridorKey(key), null, JSON.stringify(key));
  }
});

test('an unknown method is rejected, not passed through as a string', () => {
  // TypeScript cannot help at a database or HTTP boundary, so the runtime check
  // is the one that counts.
  assert.equal(parseCorridorKey('NG:swift:NGN'), null);
  assert.ok(!isWellFormed({ country: 'NG', method: 'swift' as never, currency: 'NGN' }));
});

test('well-formed is about shape, not coverage', () => {
  // Antarctica is a well-formed corridor and an unroutable one. Keeping those
  // separate is what stops a validation error from being mistaken for
  // "we do not serve you" — the routing layer says that, with a reason.
  assert.ok(isWellFormed({ country: 'AQ', method: 'bank', currency: 'XXX' }));
});

test('every method has a label a person could pick from a list', () => {
  for (const method of PAYOUT_METHODS) {
    assert.ok(METHOD_LABELS[method]?.length > 0, method);
  }
  assert.equal(Object.keys(METHOD_LABELS).length, PAYOUT_METHODS.length);
});
