import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_CURRENCIES, currencyMeta, isSupportedCurrency, formatLocal } from './currencies.ts';

/**
 * These numbers get read by someone deciding whether to cash out, so the
 * arithmetic and the labelling both matter.
 */

test('currency lookup is case-insensitive and rejects unknowns', () => {
  assert.ok(isSupportedCurrency('ngn'));
  assert.ok(isSupportedCurrency('NGN'));
  assert.ok(!isSupportedCurrency('XYZ'));
  assert.equal(currencyMeta('ngn')?.symbol, '₦');
  assert.equal(currencyMeta('XYZ'), null);
});

test('every supported currency has a symbol and a name', () => {
  for (const c of SUPPORTED_CURRENCIES) {
    assert.ok(c.symbol.length > 0, `${c.code} has no symbol`);
    assert.ok(c.name.length > 0, `${c.code} has no name`);
    assert.match(c.code, /^[A-Z]{3}$/);
  }
});

test('converts at the given rate', () => {
  const rate = { currency: 'NGN', perUsd: 1338.83201, asOf: 'x' };
  // 50 USD at 1338.83 is 66,941 — grouped, no decimals above 1000.
  assert.equal(formatLocal(50, rate), '₦66,942');
  assert.equal(formatLocal(1, rate), '₦1,339');
});

test('keeps minor units below a thousand, drops them above', () => {
  // Two decimals on a six-figure indicative number is false precision.
  const ngn = { currency: 'NGN', perUsd: 1000, asOf: 'x' };
  assert.equal(formatLocal(0.5, ngn), '₦500.00');
  assert.equal(formatLocal(5, ngn), '₦5,000');
});

test('a zero balance converts to zero, not to nothing', () => {
  const rate = { currency: 'EUR', perUsd: 0.862295, asOf: 'x' };
  assert.equal(formatLocal(0, rate), '€0.00');
});

test('USD is supported so the selector always has a neutral option', () => {
  // Otherwise a user in an unsupported market has no way to see a plain dollar
  // figure.
  assert.ok(isSupportedCurrency('USD'));
});
