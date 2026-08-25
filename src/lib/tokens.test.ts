import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBaseUnits, fromBaseUnits, formatAmount, findTokenBySymbol, SOL } from './tokens.ts';

/**
 * Decimal handling is the single most dangerous piece of arithmetic in the app:
 * a wrong exponent sends 1000x the intended amount to a stranger, irreversibly.
 */

test('converts whole and fractional SOL exactly', () => {
  assert.equal(toBaseUnits('1', 9), 1_000_000_000n);
  assert.equal(toBaseUnits('0.5', 9), 500_000_000n);
  assert.equal(toBaseUnits('0.000000001', 9), 1n);
});

test('avoids the float multiplication error that underpays', () => {
  // 0.29 * 1e9 is 289999999.99999994 in IEEE-754. Truncating loses a lamport;
  // string shifting is exact.
  assert.equal(toBaseUnits('0.29', 9), 290_000_000n);
  assert.equal(toBaseUnits('4.7', 9), 4_700_000_000n);
  assert.equal(toBaseUnits('8.2', 9), 8_200_000_000n);
});

test('respects per-token decimals', () => {
  assert.equal(toBaseUnits('1', 6), 1_000_000n); // USDC
  assert.equal(toBaseUnits('100000', 5), 10_000_000_000n); // BONK
});

test('refuses more precision than the token has', () => {
  // Silently rounding would send a different amount than the person typed.
  assert.throws(() => toBaseUnits('0.0000001', 6), /decimal places/);
  assert.throws(() => toBaseUnits('1.123456789012', 9), /decimal places/);
});

test('rejects malformed amounts', () => {
  assert.throws(() => toBaseUnits('abc', 9));
  assert.throws(() => toBaseUnits('', 9));
  assert.throws(() => toBaseUnits('.', 9));
});

test('round-trips through base units', () => {
  for (const [value, decimals] of [
    ['1', 9],
    ['0.5', 9],
    ['123.456', 6],
    ['100000', 5],
    ['0.000000001', 9],
  ] as const) {
    assert.equal(fromBaseUnits(toBaseUnits(value, decimals), decimals), value);
  }
});

test('trims trailing zeros when formatting', () => {
  assert.equal(fromBaseUnits(1_500_000_000n, 9), '1.5');
  assert.equal(fromBaseUnits(1_000_000_000n, 9), '1');
});

test('groups thousands for readability', () => {
  const bonk = findTokenBySymbol('BONK');
  assert.ok(bonk);
  assert.equal(formatAmount(toBaseUnits('1000000', bonk.decimals), bonk), '1,000,000 BONK');
  assert.equal(formatAmount(toBaseUnits('1.5', SOL.decimals), SOL), '1.5 SOL');
});

test('resolves symbols case-insensitively', () => {
  assert.equal(findTokenBySymbol('sol')?.symbol, 'SOL');
  assert.equal(findTokenBySymbol('  usdc ')?.symbol, 'USDC');
  assert.equal(findTokenBySymbol('NOTATOKEN'), null);
});

test('SOL is the native token', () => {
  assert.equal(SOL.mint, null);
  assert.equal(SOL.decimals, 9);
});
