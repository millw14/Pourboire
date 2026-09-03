import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideSponsorship,
  withdrawableNativeWei,
  ratchetOutstanding,
  DEFAULT_LIMITS,
  weiToGweiCeil,
  type SponsorRequest,
} from './policy.ts';

/**
 * The sponsor is a second hot key that signs on its own. Everything it will and
 * will not do is decided here, so this is where it gets tested.
 */

const GWEI = 1_000_000_000n;

const base: SponsorRequest = {
  intent: 'swap',
  balanceWei: 0n,
  requiredWei: 240_000_000_000_000n, // 0.00024 ETH — a swap at 0.5 gwei
  userSpentTodayWei: 0n,
  userSpentLifetimeWei: 0n,
  globalSpentTodayWei: 0n,
  sponsorBalanceWei: 100_000_000_000_000_000n, // 0.1 ETH
  gasPriceWei: GWEI / 2n,
  signedIn: true,
  configured: true,
  limits: DEFAULT_LIMITS,
};

test('an empty wallet is topped up by exactly what it is short', () => {
  const d = decideSponsorship(base);
  assert.ok(d.sponsor);
  assert.equal(d.amountWei, base.requiredWei);
});

test('a wallet that can already pay is left alone', () => {
  const d = decideSponsorship({ ...base, balanceWei: base.requiredWei });
  assert.ok(!d.sponsor);
  assert.equal(d.reason, 'not_needed');
});

test('the grant is the shortfall, so leftover gas shrinks the next one', () => {
  // The property that makes an idle loop stop paying out without needing to
  // detect that it is a loop: a grant that went unspent is still in the wallet,
  // so it is subtracted from the next request.
  const partial = decideSponsorship({ ...base, balanceWei: base.requiredWei - 1_000n });
  assert.ok(partial.sponsor);
  assert.equal(partial.amountWei, 1_000n);

  const leftover = decideSponsorship({ ...base, balanceWei: base.requiredWei });
  assert.ok(!leftover.sponsor);
  assert.equal(leftover.reason, 'not_needed');
});

test('an account that has never been signed into gets nothing', () => {
  // A tweet mints a custodial wallet for any handle it names, so "a user row
  // exists" is free to an attacker. A Privy sign-in is the cheapest thing here
  // that is not.
  const d = decideSponsorship({ ...base, signedIn: false });
  assert.ok(!d.sponsor);
  assert.equal(d.reason, 'not_signed_in');
});

test('no sponsor key means the old behaviour, not an error', () => {
  const d = decideSponsorship({ ...base, configured: false });
  assert.ok(!d.sponsor);
  assert.equal(d.reason, 'unconfigured');
  // The same sentence the routes used before sponsorship existed.
  assert.match(d.message, /top up a little ETH/i);
});

test('a gas spike is refused rather than funded', () => {
  // Sizing a grant against a spike is how one bad hour empties the wallet.
  const d = decideSponsorship({ ...base, gasPriceWei: DEFAULT_LIMITS.maxGasPriceWei + 1n });
  assert.ok(!d.sponsor);
  assert.equal(d.reason, 'gas_price_spike');
});

test('the gas-price ceiling is inclusive', () => {
  const d = decideSponsorship({ ...base, gasPriceWei: DEFAULT_LIMITS.maxGasPriceWei });
  assert.ok(d.sponsor);
});

test('each cap refuses in its own name', () => {
  // A refusal that names the wrong cap sends an operator looking in the wrong
  // place, and tells the user something untrue.
  const overGrant = decideSponsorship({ ...base, requiredWei: DEFAULT_LIMITS.perGrantWei + 1n });
  assert.ok(!overGrant.sponsor);
  assert.equal(overGrant.reason, 'per_grant_cap');

  const overDaily = decideSponsorship({
    ...base,
    userSpentTodayWei: DEFAULT_LIMITS.perUserDailyWei,
  });
  assert.ok(!overDaily.sponsor);
  assert.equal(overDaily.reason, 'daily_cap');

  const overLifetime = decideSponsorship({
    ...base,
    userSpentLifetimeWei: DEFAULT_LIMITS.perUserLifetimeWei,
  });
  assert.ok(!overLifetime.sponsor);
  assert.equal(overLifetime.reason, 'lifetime_cap');

  const overGlobal = decideSponsorship({
    ...base,
    globalSpentTodayWei: DEFAULT_LIMITS.globalDailyWei,
  });
  assert.ok(!overGlobal.sponsor);
  assert.equal(overGlobal.reason, 'global_daily_cap');
});

test('caps are boundaries, not approximations', () => {
  // Landing exactly on a cap is allowed; a single wei past it is not.
  const exactlyDaily = DEFAULT_LIMITS.perUserDailyWei - base.requiredWei;
  assert.ok(decideSponsorship({ ...base, userSpentTodayWei: exactlyDaily }).sponsor);
  assert.ok(!decideSponsorship({ ...base, userSpentTodayWei: exactlyDaily + 1n }).sponsor);
});

test('the sponsor keeps a floor so it can never strand itself', () => {
  const d = decideSponsorship({ ...base, sponsorBalanceWei: DEFAULT_LIMITS.sponsorFloorWei });
  assert.ok(!d.sponsor);
  assert.equal(d.reason, 'sponsor_exhausted');
});

test('a low sponsor wallet is not announced to the person asking', () => {
  // Anyone can probe the earlier caps. Whether our hot wallet is running dry is
  // not something to hand them.
  const d = decideSponsorship({ ...base, sponsorBalanceWei: 0n });
  assert.ok(!d.sponsor);
  assert.equal(d.reason, 'sponsor_exhausted');
  assert.ok(!/sponsor|balance|fund/i.test(d.message), d.message);
});

test('eligibility is decided before any budget', () => {
  // Otherwise a signed-out probe could learn where the caps sit.
  const d = decideSponsorship({
    ...base,
    signedIn: false,
    userSpentTodayWei: DEFAULT_LIMITS.perUserDailyWei,
    sponsorBalanceWei: 0n,
  });
  assert.equal(d.sponsor === false && d.reason, 'not_signed_in');
});

test('not-needed beats every other refusal', () => {
  // Someone who can already pay must never be told they hit a cap.
  const d = decideSponsorship({
    ...base,
    balanceWei: base.requiredWei,
    signedIn: false,
    configured: false,
    sponsorBalanceWei: 0n,
  });
  assert.equal(d.sponsor === false && d.reason, 'not_needed');
});

test('a granted amount is never more than the caps allow', () => {
  // The invariant that matters most: whatever the inputs, the sponsor never
  // signs away more than one grant, and never more than the shortfall.
  for (const requiredWei of [1n, 100_000n, 240_000_000_000_000n, DEFAULT_LIMITS.perGrantWei]) {
    for (const balanceWei of [0n, 1n, requiredWei / 2n]) {
      const d = decideSponsorship({ ...base, requiredWei, balanceWei });
      if (d.sponsor) {
        assert.ok(d.amountWei > 0n, 'a granted amount is always positive');
        assert.ok(d.amountWei <= DEFAULT_LIMITS.perGrantWei);
        assert.ok(d.amountWei <= requiredWei - balanceWei);
      }
    }
  }
});

/* --------------------------------------------------- keeping the gas there */

test('sponsored ETH cannot simply be withdrawn', () => {
  // Without this the sponsor is a faucet with a withdraw button: put ETH in,
  // take ETH out, lose only the gas of the withdrawal.
  const free = withdrawableNativeWei({
    balanceWei: 1_000_000_000_000_000n,
    outstandingWei: 1_000_000_000_000_000n,
    reserveWei: 200_000_000_000_000n,
  });
  assert.equal(free, 0n);
});

test('the grant and the ordinary reserve do not stack', () => {
  // Locking both would hold a sponsored user back twice for the same reason.
  const balanceWei = 1_000_000_000_000_000n;
  const free = withdrawableNativeWei({
    balanceWei,
    outstandingWei: 600_000_000_000_000n,
    reserveWei: 200_000_000_000_000n,
  });
  assert.equal(free, balanceWei - 600_000_000_000_000n);
});

test('a user who funded their own wallet can still withdraw the rest', () => {
  const free = withdrawableNativeWei({
    balanceWei: 5_000_000_000_000_000n,
    outstandingWei: 1_000_000_000_000_000n,
    reserveWei: 200_000_000_000_000n,
  });
  assert.equal(free, 4_000_000_000_000_000n);
});

test('withdrawable never goes negative', () => {
  assert.equal(withdrawableNativeWei({ balanceWei: 0n, outstandingWei: 10n, reserveWei: 5n }), 0n);
});

test('spending the gas releases the lock', () => {
  // The balance falling is the evidence the grant was used for what it was for.
  // Otherwise a user stays locked all day for having accepted help once.
  assert.equal(ratchetOutstanding(1_000n, 400n), 400n);
  assert.equal(ratchetOutstanding(1_000n, 0n), 0n);
});

test('the lock never ratchets up', () => {
  // A user topping up their own wallet must not increase what is held against
  // them.
  assert.equal(ratchetOutstanding(1_000n, 9_999n), 1_000n);
  assert.equal(ratchetOutstanding(0n, 9_999n), 0n);
});

test('the default limits are ordered sensibly', () => {
  // A per-grant cap above the daily one, or a daily above the lifetime, would
  // make a cap unreachable and quietly disable it.
  assert.ok(DEFAULT_LIMITS.perGrantWei <= DEFAULT_LIMITS.perUserDailyWei);
  assert.ok(DEFAULT_LIMITS.perUserDailyWei <= DEFAULT_LIMITS.perUserLifetimeWei);
  assert.ok(DEFAULT_LIMITS.perUserLifetimeWei <= DEFAULT_LIMITS.globalDailyWei);
});

test('the per-grant cap actually covers the swap it exists for', () => {
  // 480,000 gas at the 2 gwei ceiling is 0.00096 ETH. A per-grant cap below that
  // would refuse the exact transaction this feature was built to unblock.
  const worstSwap = 480_000n * DEFAULT_LIMITS.maxGasPriceWei;
  assert.ok(
    DEFAULT_LIMITS.perGrantWei >= worstSwap,
    `per-grant ${DEFAULT_LIMITS.perGrantWei} does not cover a worst-case swap ${worstSwap}`
  );
});

test('wei to gwei rounds up, so the budget is never undercounted', () => {
  // A cap that rounds down is a cap that can be walked past one wei at a time.
  assert.equal(weiToGweiCeil(0n), 0);
  assert.equal(weiToGweiCeil(1n), 1);
  assert.equal(weiToGweiCeil(1_000_000_000n), 1);
  assert.equal(weiToGweiCeil(1_000_000_001n), 2);
  assert.equal(weiToGweiCeil(DEFAULT_LIMITS.perGrantWei), 1_000_000);
});

test('the global cap in gwei stays exactly representable', () => {
  // The whole reason this counter is a Number rather than a string. If a
  // realistic cap could exceed 2^53 the arithmetic would silently drift.
  assert.ok(weiToGweiCeil(DEFAULT_LIMITS.globalDailyWei) < Number.MAX_SAFE_INTEGER);
  assert.ok(Number.isSafeInteger(weiToGweiCeil(DEFAULT_LIMITS.globalDailyWei)));
});
