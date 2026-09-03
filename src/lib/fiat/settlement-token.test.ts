import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSettlementToken,
  isNeverSettlement,
  type SettlementCandidate,
} from './settlement-token.ts';

/**
 * The plan excludes auto-selling an equity to fund a payout. These tests are
 * that exclusion, made enforceable.
 */

const USDG_ADDRESS = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const rail = { tokenSymbol: 'USDG', tokenAddress: USDG_ADDRESS };

const usdg: SettlementCandidate = { symbol: 'USDG', address: USDG_ADDRESS, kind: 'stable' };
const nvda: SettlementCandidate = { symbol: 'NVDA', address: '0xnvda', kind: 'equity' };

test('the rail stablecoin settles', () => {
  assert.ok(checkSettlementToken(usdg, rail).ok);
});

test('no equity is ever a settlement asset', () => {
  // The whole point. Cashing out must never become a sale nobody authorised.
  for (const symbol of ['NVDA', 'SPY', 'GME', 'QQQ', 'MSTR', 'GLD', 'SPCX']) {
    const decision = checkSettlementToken(
      { symbol, address: '0xabc', kind: 'equity' },
      rail
    );
    assert.ok(!decision.ok, symbol);
    assert.equal(decision.reason, 'equity_not_settlement');
  }
});

test('the refusal tells the user what to do instead, and names both tokens', () => {
  // "Not supported" would leave someone stuck holding an asset they thought was
  // spendable. The point of the message is that swapping first is their choice.
  const decision = checkSettlementToken(nvda, rail);
  assert.ok(!decision.ok);
  assert.match(decision.message, /NVDA/);
  assert.match(decision.message, /USDG/);
  assert.match(decision.message, /yourself/i);
});

test('an equity is refused even if a corridor somehow declares one as its rail', () => {
  // Kind is checked before the rail, so a misconfigured capability table cannot
  // authorise a sale.
  const decision = checkSettlementToken(nvda, { tokenSymbol: 'NVDA', tokenAddress: '0xnvda' });
  assert.ok(!decision.ok);
  assert.equal(decision.reason, 'equity_not_settlement');
});

test('ETH is refused because it pays gas', () => {
  const decision = checkSettlementToken(
    { symbol: 'ETH', address: null, kind: 'native' },
    rail
  );
  assert.ok(!decision.ok);
  assert.equal(decision.reason, 'native_not_settlement');
});

test('a tweet-named token is refused, whatever it calls itself', () => {
  // resolveToken accepts a bare contract address from a tweet and reads its
  // symbol off-chain. Nothing arriving that way settles.
  const decision = checkSettlementToken(
    { symbol: 'USDG', address: '0xdeadbeef', kind: 'meme' },
    rail
  );
  assert.ok(!decision.ok);
  assert.equal(decision.reason, 'meme_not_settlement');
});

test('a stablecoin at the wrong address is refused, however it is labelled', () => {
  // A symbol is whatever a contract claims. Two contracts can both answer
  // 'USDG', so the comparison is on the address the provider actually declared.
  const impostor: SettlementCandidate = {
    symbol: 'USDG',
    address: '0x0000000000000000000000000000000000000001',
    kind: 'stable',
  };
  const decision = checkSettlementToken(impostor, rail);
  assert.ok(!decision.ok);
  assert.equal(decision.reason, 'wrong_settlement_token');
});

test('address comparison ignores checksum casing', () => {
  // Addresses arrive checksummed from viem and lowercase from the database. A
  // case-sensitive compare would refuse the correct token.
  assert.ok(
    checkSettlementToken({ ...usdg, address: USDG_ADDRESS.toUpperCase() }, rail).ok
  );
  assert.ok(
    checkSettlementToken(usdg, { ...rail, tokenAddress: USDG_ADDRESS.toUpperCase() }).ok
  );
});

test('the cheap pre-check refuses every category that is wrong regardless of corridor', () => {
  assert.ok(isNeverSettlement('equity'));
  assert.ok(isNeverSettlement('native'));
  assert.ok(isNeverSettlement('meme'));
  // Stable is the only one that can pass, and it still has to match the rail —
  // which this check cannot know, which is why it is not the real gate.
  assert.ok(!isNeverSettlement('stable'));
});
