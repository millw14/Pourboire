import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  spendableLamports,
  solToLamports,
  RENT_EXEMPT_RESERVE,
  FEE_RESERVE,
} from './lamports.ts';

/**
 * Lamport arithmetic. Getting these wrong costs users money, and two of the
 * behaviours below are regressions that already happened once.
 */

test('spendable leaves room for the fee and rent exemption', () => {
  const balance = 1_000_000_000; // 1 SOL
  assert.equal(spendableLamports(balance), balance - RENT_EXEMPT_RESERVE - FEE_RESERVE);
});

test('spendable never goes negative on a dust balance', () => {
  // The old withdraw route compared against the raw balance, so "withdraw
  // everything" built a transaction that could not pay its own fee.
  assert.equal(spendableLamports(0), 0);
  assert.equal(spendableLamports(1000), 0);
});

test('solToLamports rounds instead of truncating', () => {
  // 0.1 * LAMPORTS_PER_SOL is 100000000.00000001 in IEEE-754. Math.floor on
  // neighbouring values silently drops a lamport.
  assert.equal(solToLamports(0.1), 100_000_000);
  assert.equal(solToLamports(1), 1_000_000_000);
  assert.equal(solToLamports(0.000000001), 1);
});

test('solToLamports handles a value that floors badly', () => {
  assert.equal(solToLamports(4.7), 4_700_000_000);
  assert.equal(solToLamports(8.2), 8_200_000_000);
});

