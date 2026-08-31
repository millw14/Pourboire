import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toBaseUnits,
  fromBaseUnits,
  formatAmount,
  findTokenBySymbol,
  findTokenByAddress,
  tokenFromRecord,
  DEFAULT_TOKEN,
  NATIVE,
  KNOWN_TOKENS,
} from './tokens.ts';

/**
 * Decimal handling is the single most dangerous arithmetic in the app: a wrong
 * exponent sends 1000x the intended amount to a stranger, irreversibly.
 *
 * On this chain the trap is sharper than it was on Solana, because the decimals
 * are not uniform — USDG is 6 and every tokenised equity is 18. Treating them
 * alike is a factor-of-a-trillion error.
 */

test('USDG is 6 decimals and the equities are 18', () => {
  // Read off the chain, not copied from a listing site. If this ever changes,
  // every amount in the app is wrong by a factor of 10^12.
  assert.equal(findTokenBySymbol('USDG')?.decimals, 6);
  assert.equal(findTokenBySymbol('NVDA')?.decimals, 18);
  assert.equal(findTokenBySymbol('SPY')?.decimals, 18);
  assert.equal(NATIVE.decimals, 18);
});

test('the same written amount means different base units per token', () => {
  const usdg = findTokenBySymbol('USDG')!;
  const nvda = findTokenBySymbol('NVDA')!;
  assert.equal(toBaseUnits('1', usdg.decimals), 1_000_000n);
  assert.equal(toBaseUnits('1', nvda.decimals), 1_000_000_000_000_000_000n);
});

test('converts whole and fractional amounts exactly', () => {
  assert.equal(toBaseUnits('1', 18), 1_000_000_000_000_000_000n);
  assert.equal(toBaseUnits('0.5', 18), 500_000_000_000_000_000n);
  assert.equal(toBaseUnits('0.000001', 6), 1n);
});

test('avoids the float multiplication error that underpays', () => {
  // 0.29 * 1e18 is not an integer in IEEE-754. Truncating loses value;
  // string shifting is exact.
  assert.equal(toBaseUnits('0.29', 18), 290_000_000_000_000_000n);
  assert.equal(toBaseUnits('4.7', 6), 4_700_000n);
  assert.equal(toBaseUnits('0.1', 6), 100_000n);
});

test('rejects more precision than the token can hold', () => {
  // Silently truncating someone's amount is worse than refusing it.
  assert.throws(() => toBaseUnits('1.1234567', 6), /decimal places/);
  // Trailing zeros beyond the limit are not real precision, so they pass.
  assert.equal(toBaseUnits('1.100000000', 6), 1_100_000n);
});

test('rejects things that are not numbers', () => {
  for (const bad of ['', '.', 'abc', '1.2.3', '-1', '1e18']) {
    assert.throws(() => toBaseUnits(bad, 18), new RegExp('not a number|decimal places'), bad);
  }
});

test('round-trips through base units', () => {
  for (const [value, decimals] of [
    ['1', 18],
    ['0.5', 6],
    ['1234.5678', 18],
    ['0.000001', 6],
  ] as const) {
    assert.equal(fromBaseUnits(toBaseUnits(value, decimals), decimals), value);
  }
});

test('formats with thousands separators and the right symbol', () => {
  const usdg = findTokenBySymbol('USDG')!;
  assert.equal(formatAmount(1_500_000n, usdg), '1.5 USDG');
  assert.equal(formatAmount(1_000_000_000n, usdg), '1,000 USDG');
  assert.equal(formatAmount(1_000_000_000_000_000_000n, NATIVE), '1 ETH');
});

test('every registry address is a checksummable 0x address', () => {
  for (const token of KNOWN_TOKENS) {
    if (token.address === null) continue;
    assert.match(token.address, /^0x[0-9a-fA-F]{40}$/, `${token.symbol} has a malformed address`);
  }
});

test('no two registry entries share a symbol or an address', () => {
  // A duplicate symbol would make `findTokenBySymbol` resolve a tip to whichever
  // entry happened to come first.
  const symbols = KNOWN_TOKENS.map((t) => t.symbol.toUpperCase());
  assert.equal(new Set(symbols).size, symbols.length);

  const addresses = KNOWN_TOKENS.map((t) => t.address?.toLowerCase()).filter(Boolean);
  assert.equal(new Set(addresses).size, addresses.length);
});

test('lookups are case-insensitive in both directions', () => {
  assert.equal(findTokenBySymbol('usdg')?.symbol, 'USDG');
  const nvda = findTokenBySymbol('NVDA')!;
  assert.equal(findTokenByAddress(nvda.address!.toUpperCase())?.symbol, 'NVDA');
});

test('the default token is the dollar one', () => {
  // Tips with no token named are denominated in something stable, which is what
  // makes cashing out to local currency coherent.
  assert.equal(DEFAULT_TOKEN.symbol, 'USDG');
  assert.equal(DEFAULT_TOKEN.kind, 'stable');
});

test('an unknown token keeps the decimals its record remembers', () => {
  // A token that drops off the registry must still render historic amounts
  // correctly — otherwise old history silently changes value.
  const rebuilt = tokenFromRecord({
    tokenSymbol: 'GONE',
    tokenMint: '0x1234567890123456789012345678901234567890',
    tokenDecimals: 9,
  });
  assert.equal(rebuilt.decimals, 9);
  assert.equal(formatAmount(1_500_000_000n, rebuilt), '1.5 GONE');
});
