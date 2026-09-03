import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoute, mayFailOver, type RouteQuery } from './routing.ts';
import { CAPABILITIES, type CorridorCapability } from './capabilities.ts';
import type { Corridor } from './corridors.ts';

/**
 * Routing decides which provider gets someone's money. Its failures are as
 * important as its successes: "we do not serve Nigeria", "Nigeria is off right
 * now" and "that is below the minimum" are three different sentences for the
 * person waiting, and a bare null would collapse them into one shrug.
 */

const NG: Corridor = { country: 'NG', method: 'bank', currency: 'NGN' };
const BR: Corridor = { country: 'BR', method: 'pix', currency: 'BRL' };

const rail = {
  chainId: 4663,
  tokenSymbol: 'USDG',
  tokenAddress: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  depositAddress: '0xdeposit',
};

function capability(over: Partial<CorridorCapability> = {}): CorridorCapability {
  return {
    provider: 'alpha',
    corridor: NG,
    priority: 10,
    limits: { minMinor: '10000', maxMinor: '100000000' },
    requires: ['accountNumber', 'bankCode'],
    rail,
    etaHours: [1, 24],
    ...over,
  };
}

function query(over: Partial<RouteQuery> = {}): RouteQuery {
  return {
    corridor: NG,
    amountMinor: 500_000n,
    table: [capability()],
    enabled: new Set(['alpha']),
    supportedRails: new Set([4663]),
    ...over,
  };
}

test('the shipped capability table is empty, so nothing routes yet', () => {
  // Deliberate. Publishing a corridor we have never exercised against a live API
  // is the same class of lie as a button that looks enabled. When this assertion
  // changes, it should be because a real payout has been made on that corridor.
  assert.deepEqual(CAPABILITIES, []);
  const result = resolveRoute(query({ table: CAPABILITIES }));
  assert.ok(!result.ok);
  assert.equal(result.reason, 'no_provider');
});

test('a matching, enabled, settleable, in-limits capability routes', () => {
  const result = resolveRoute(query());
  assert.ok(result.ok);
  assert.equal(result.route.provider, 'alpha');
  assert.deepEqual(result.alternates, []);
});

test('an unserved corridor and a disabled provider are different answers', () => {
  const unserved = resolveRoute(query({ corridor: BR }));
  assert.ok(!unserved.ok);
  assert.equal(unserved.reason, 'no_provider');

  const off = resolveRoute(query({ enabled: new Set() }));
  assert.ok(!off.ok);
  assert.equal(off.reason, 'provider_disabled');
  // "Temporarily" is the whole difference — one is worth waiting for.
  assert.match(off.message, /temporarily/i);
});

test('the same country by a different method is a different corridor', () => {
  // Nigeria by bank and Nigeria by mobile money are separate claims, and only
  // one of them has been exercised.
  const result = resolveRoute(
    query({ corridor: { country: 'NG', method: 'mobile_money', currency: 'NGN' } })
  );
  assert.ok(!result.ok);
  assert.equal(result.reason, 'no_provider');
});

test('a corridor we cannot settle on says so, rather than failing vaguely', () => {
  // Declared and funded, but the provider wants the stablecoin on a chain we
  // have no bridge to. This is the case the whole system is expected to hit
  // first, because no provider settles USDG on Robinhood Chain.
  const result = resolveRoute(query({ supportedRails: new Set([8453]) }));
  assert.ok(!result.ok);
  assert.equal(result.reason, 'rail_unsupported');
});

test('too small and too large are told apart', () => {
  // Telling someone "too small" when they meant to send too much is worse than
  // useless.
  const small = resolveRoute(query({ amountMinor: 1n }));
  assert.ok(!small.ok);
  assert.equal(small.reason, 'below_minimum');
  assert.match(small.message, /100\.00 NGN/);

  const large = resolveRoute(query({ amountMinor: 10n ** 12n }));
  assert.ok(!large.ok);
  assert.equal(large.reason, 'above_maximum');
  assert.match(large.message, /1000000\.00 NGN/);
});

test('the limits are inclusive at both ends', () => {
  // An off-by-one here refuses a payout for exactly the minimum, which is the
  // amount people actually try.
  assert.ok(resolveRoute(query({ amountMinor: 10_000n })).ok);
  assert.ok(resolveRoute(query({ amountMinor: 100_000_000n })).ok);
  assert.ok(!resolveRoute(query({ amountMinor: 9_999n })).ok);
  assert.ok(!resolveRoute(query({ amountMinor: 100_000_001n })).ok);
});

test('limits are compared as bigints, not numbers', () => {
  // Minor units of a weak currency pass Number.MAX_SAFE_INTEGER sooner than
  // anyone expects, and a float comparison there silently rounds.
  const result = resolveRoute(
    query({
      amountMinor: 9_007_199_254_740_993_000n,
      table: [capability({ limits: { minMinor: '1', maxMinor: '9007199254740993000' } })],
    })
  );
  assert.ok(result.ok);
});

test('a blocked country is refused before anything else is considered', () => {
  // Sanctions and suspensions must not depend on whether a provider happens to
  // be configured, so the check runs first.
  const result = resolveRoute(query({ table: [], blockedCountries: new Set(['NG']) }));
  assert.ok(!result.ok);
  assert.equal(result.reason, 'country_blocked');
});

test('providers are ranked by priority, with the rest offered as alternates', () => {
  const result = resolveRoute(
    query({
      table: [capability({ provider: 'beta', priority: 5 }), capability({ provider: 'alpha' })],
      enabled: new Set(['alpha', 'beta']),
    })
  );
  assert.ok(result.ok);
  assert.equal(result.route.provider, 'beta');
  assert.deepEqual(
    result.alternates.map((a) => a.provider),
    ['alpha']
  );
});

test('a tie resolves the same way on every machine', () => {
  // Table order comes from a file that gets reordered by merges; a routing
  // decision that depends on it cannot be reconstructed during a dispute.
  const forwards = resolveRoute(
    query({
      table: [capability({ provider: 'zed' }), capability({ provider: 'ace' })],
      enabled: new Set(['zed', 'ace']),
    })
  );
  const backwards = resolveRoute(
    query({
      table: [capability({ provider: 'ace' }), capability({ provider: 'zed' })],
      enabled: new Set(['zed', 'ace']),
    })
  );
  assert.ok(forwards.ok && backwards.ok);
  assert.equal(forwards.route.provider, 'ace');
  assert.equal(backwards.route.provider, 'ace');
});

test('a disabled provider is skipped rather than ranked', () => {
  const result = resolveRoute(
    query({
      table: [capability({ provider: 'beta', priority: 1 }), capability({ provider: 'alpha' })],
      enabled: new Set(['alpha']),
    })
  );
  assert.ok(result.ok);
  assert.equal(result.route.provider, 'alpha');
});

test('the enabled set can only ever take a corridor away', () => {
  // A provider absent from the table cannot be switched on by an env var. The
  // worst a runtime override can do is disable something.
  const result = resolveRoute(query({ table: [], enabled: new Set(['ghost']) }));
  assert.ok(!result.ok);
  assert.equal(result.reason, 'no_provider');
});

test('every failure carries a message fit to show a person', () => {
  const failures = [
    resolveRoute(query({ table: [] })),
    resolveRoute(query({ enabled: new Set() })),
    resolveRoute(query({ supportedRails: new Set() })),
    resolveRoute(query({ amountMinor: 1n })),
    resolveRoute(query({ amountMinor: 10n ** 15n })),
    resolveRoute(query({ blockedCountries: new Set(['NG']) })),
  ];
  for (const f of failures) {
    assert.ok(!f.ok);
    assert.ok(f.message.length > 10);
    assert.ok(!/undefined|null|\[object/.test(f.message), f.message);
  }
});

/* ----------------------------------------------------------------- failover */

test('failover is only possible before anything has moved', () => {
  const current = capability({ provider: 'alpha' });
  const alternate = capability({ provider: 'beta' });

  assert.ok(mayFailOver({ status: 'quoted', refusalWasDefinite: true, current, alternate }));
  // Once the stablecoin has been sent to alpha's deposit address, moving to beta
  // would leave the funds with alpha while beta is expected to pay.
  for (const status of ['funding', 'funded', 'submitted', 'submit_indeterminate', 'paid']) {
    assert.ok(!mayFailOver({ status, refusalWasDefinite: true, current, alternate }), status);
  }
});

test('an indefinite refusal never fails over', () => {
  // If we do not know whether the first provider accepted it, handing the same
  // payout to a second is how it gets paid twice.
  assert.ok(
    !mayFailOver({
      status: 'quoted',
      refusalWasDefinite: false,
      current: capability({ provider: 'alpha' }),
      alternate: capability({ provider: 'beta' }),
    })
  );
});

test('failover requires an identical settlement rail', () => {
  const current = capability({ provider: 'alpha' });
  const alternates = [
    capability({ provider: 'beta', rail: { ...rail, chainId: 8453 } }),
    capability({ provider: 'beta', rail: { ...rail, tokenAddress: '0xother' } }),
    capability({ provider: 'beta', rail: { ...rail, depositAddress: '0xelsewhere' } }),
  ];
  for (const alternate of alternates) {
    assert.ok(!mayFailOver({ status: 'quoted', refusalWasDefinite: true, current, alternate }));
  }
});

test('rail comparison ignores address casing', () => {
  // EVM addresses arrive checksummed from some sources and lowercase from
  // others; a case-sensitive compare would refuse a perfectly good failover.
  const current = capability({ provider: 'alpha' });
  const alternate = capability({
    provider: 'beta',
    rail: {
      ...rail,
      tokenAddress: rail.tokenAddress.toUpperCase(),
      depositAddress: '0xDEPOSIT',
    },
  });
  assert.ok(mayFailOver({ status: 'quoted', refusalWasDefinite: true, current, alternate }));
});

test('a null amount skips the limit check entirely', () => {
  // Adding a beneficiary is a question about a corridor, not a payment. Refusing
  // to tokenise a bank account for being "below the minimum payout" is nonsense,
  // so the amount is genuinely absent rather than zero.
  const result = resolveRoute(query({ amountMinor: null }));
  assert.ok(result.ok);
  assert.equal(result.route.provider, 'alpha');

  // Zero is not the same thing, and still fails as an amount.
  const zero = resolveRoute(query({ amountMinor: 0n }));
  assert.ok(!zero.ok);
  assert.equal(zero.reason, 'below_minimum');
});

test('a null amount still respects every other filter', () => {
  // Skipping limits must not become skipping the corridor, the provider, the
  // rail, or the country block.
  assert.equal(
    (resolveRoute(query({ amountMinor: null, table: [] })) as { reason: string }).reason,
    'no_provider'
  );
  assert.equal(
    (resolveRoute(query({ amountMinor: null, enabled: new Set() })) as { reason: string }).reason,
    'provider_disabled'
  );
  assert.equal(
    (resolveRoute(query({ amountMinor: null, supportedRails: new Set() })) as { reason: string })
      .reason,
    'rail_unsupported'
  );
  assert.equal(
    (
      resolveRoute(query({ amountMinor: null, blockedCountries: new Set(['NG']) })) as {
        reason: string;
      }
    ).reason,
    'country_blocked'
  );
});
