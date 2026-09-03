/**
 * Whether to put gas in someone's wallet, and how much.
 *
 * A tip creates a custodial wallet and sends it USDG. Nothing anywhere funds
 * ETH, so the recipient holds a balance they cannot move: on an EVM chain you
 * need gas to spend a token you own. `/api/me` already calls this "the state
 * people actually get stuck in", and the swap path made it worse, because a
 * swap is two transactions and therefore needs gas twice.
 *
 * Sponsorship is the fix, and it is a hot wallet that signs autonomously — so
 * the whole decision lives here, pure and tested, rather than spread across the
 * routes that call it.
 *
 * The shape that keeps it safe:
 *
 *  - **Top up the shortfall, never a fixed grant.** Leftover ETH from a
 *    sponsorship that went unused reduces the next one to zero, so an idle loop
 *    stops paying out after the first grant without needing to detect anything.
 *  - **Only for people who signed in.** A tweet mints a custodial wallet for any
 *    handle it names, so "a user row exists" costs an attacker nothing. A Privy
 *    identity is the cheapest thing here that is not free.
 *  - **Three caps, checked in order**, so a refusal always names the binding one.
 *  - **Refuse during a gas spike** rather than sizing a grant against it.
 */

export type SponsorIntent = 'withdraw' | 'swap' | 'payout';

export interface SponsorLimits {
  /** Most that may be granted in one go. */
  perGrantWei: bigint;
  /** Most one user may receive in a rolling day. */
  perUserDailyWei: bigint;
  /** Most one user may ever receive. The backstop against a patient Sybil. */
  perUserLifetimeWei: bigint;
  /** Most all users together may receive in a day. Bounds a Sybil fleet. */
  globalDailyWei: bigint;
  /** Below this the sponsor stops, keeping enough to not strand itself. */
  sponsorFloorWei: bigint;
  /** Above this gas price, refuse rather than size a grant against a spike. */
  maxGasPriceWei: bigint;
}

export interface SponsorRequest {
  intent: SponsorIntent;
  /** ETH the user's wallet already holds. */
  balanceWei: bigint;
  /** What the pending transaction needs: gas limit times gas price. */
  requiredWei: bigint;
  /** Granted to this user in the current day. */
  userSpentTodayWei: bigint;
  /** Granted to this user ever. */
  userSpentLifetimeWei: bigint;
  /** Granted to everyone in the current day. */
  globalSpentTodayWei: bigint;
  /** What the sponsor wallet itself holds. */
  sponsorBalanceWei: bigint;
  /** Current gas price, so a spike can be refused. */
  gasPriceWei: bigint;
  /** True only when the account has actually been signed into. */
  signedIn: boolean;
  /** False when no sponsor key is configured. */
  configured: boolean;
  limits: SponsorLimits;
}

export type SponsorRefusal =
  /** The wallet can already pay. Not a failure. */
  | 'not_needed'
  /** No sponsor key. The deployment simply has this switched off. */
  | 'unconfigured'
  /** The account has never been signed into, so a wallet row costs nothing. */
  | 'not_signed_in'
  | 'gas_price_spike'
  | 'per_grant_cap'
  | 'daily_cap'
  | 'lifetime_cap'
  | 'global_daily_cap'
  | 'sponsor_exhausted';

export type SponsorDecision =
  | { sponsor: true; amountWei: bigint }
  | { sponsor: false; reason: SponsorRefusal; message: string };

/**
 * Order matters. Each check answers a different question, and the first one that
 * refuses is the one the user is told about — so "you already have enough" can
 * never be reported as "we are out of funds", and vice versa.
 */
export function decideSponsorship(req: SponsorRequest): SponsorDecision {
  const { limits } = req;

  // Cheapest and most common answer first: nothing to do.
  if (req.balanceWei >= req.requiredWei) {
    return { sponsor: false, reason: 'not_needed', message: 'You already have enough ETH for gas.' };
  }

  if (!req.configured) {
    return {
      sponsor: false,
      reason: 'unconfigured',
      message: 'Not enough ETH to cover gas. Top up a little ETH and try again.',
    };
  }

  // Before any spend check, because eligibility is not a budgeting question.
  if (!req.signedIn) {
    return {
      sponsor: false,
      reason: 'not_signed_in',
      message: 'Sign in to claim this wallet before we can cover gas for you.',
    };
  }

  // A spike would make a correctly-sized grant enormous. Refusing costs the user
  // a wait; sizing against it costs the sponsor wallet.
  if (req.gasPriceWei > limits.maxGasPriceWei) {
    return {
      sponsor: false,
      reason: 'gas_price_spike',
      message: 'Network fees are unusually high right now. Try again shortly.',
    };
  }

  // The shortfall, and only the shortfall. Anything already in the wallet —
  // including an earlier grant that went unspent — reduces this, which is what
  // makes a repeated request stop paying out on its own.
  const shortfall = req.requiredWei - req.balanceWei;

  if (shortfall > limits.perGrantWei) {
    return {
      sponsor: false,
      reason: 'per_grant_cap',
      message: 'That transaction needs more gas than we cover. Top up a little ETH and try again.',
    };
  }

  if (req.userSpentTodayWei + shortfall > limits.perUserDailyWei) {
    return {
      sponsor: false,
      reason: 'daily_cap',
      message: 'We have covered as much gas as we can for you today. Try again tomorrow.',
    };
  }

  if (req.userSpentLifetimeWei + shortfall > limits.perUserLifetimeWei) {
    return {
      sponsor: false,
      reason: 'lifetime_cap',
      message: 'Not enough ETH to cover gas. Top up a little ETH and try again.',
    };
  }

  if (req.globalSpentTodayWei + shortfall > limits.globalDailyWei) {
    return {
      sponsor: false,
      reason: 'global_daily_cap',
      message: 'We cannot cover gas right now. Try again shortly.',
    };
  }

  // Checked last because it is about us, not them — and it must not leak that
  // the sponsor wallet is low to anyone probing the earlier caps.
  if (req.sponsorBalanceWei - shortfall < limits.sponsorFloorWei) {
    return {
      sponsor: false,
      reason: 'sponsor_exhausted',
      message: 'We cannot cover gas right now. Try again shortly.',
    };
  }

  return { sponsor: true, amountWei: shortfall };
}

/* ------------------------------------------------------- keeping it there */

/**
 * Sponsored ETH is a tool, not a balance.
 *
 * The moment gas lands in a custodial wallet it becomes withdrawable, and both
 * `POST /api/wallet/withdraw {"token":"ETH"}` and a plain `tip 0.0003 ETH @x`
 * settle through the same native branch. Without this, the sponsor is a faucet
 * with a withdraw button attached — put ETH in, take ETH out, lose only the
 * 21,000 gas of the withdrawal itself.
 *
 * So an outstanding grant is subtracted from what the wallet may send. Note the
 * `max` rather than a sum: the grant doubles as the anti-stranding reserve
 * `GAS_RESERVE_WEI` already provides, so a sponsored user is not held back twice
 * for the same reason.
 */
export function withdrawableNativeWei(params: {
  balanceWei: bigint;
  /** Sponsored and not yet demonstrably spent. */
  outstandingWei: bigint;
  /** The wallet's ordinary reserve, so it can always pay for its next move. */
  reserveWei: bigint;
}): bigint {
  const locked =
    params.outstandingWei > params.reserveWei ? params.outstandingWei : params.reserveWei;
  const free = params.balanceWei - locked;
  return free > 0n ? free : 0n;
}

/**
 * How much of a grant is still outstanding, given what the wallet holds now.
 *
 * Ratcheted down and never up. A user who spends their sponsored gas on the
 * transaction it was for should not stay locked for the rest of the day — the
 * balance falling is the evidence that it was used. It also means a user who
 * later funds their own wallet is not credited against the grant.
 */
export function ratchetOutstanding(storedWei: bigint, balanceWei: bigint): bigint {
  if (storedWei <= 0n) return 0n;
  return storedWei < balanceWei ? storedWei : balanceWei;
}

/**
 * Default limits, in wei.
 *
 * Sized from measured cost on this chain rather than from a guess. Gas is around
 * 0.47 gwei; a USDG transfer measures 48,436 gas and a whole swap — approve plus
 * `exactInputSingle` — measures 233,657. The repo's own gas *limits* are higher
 * than the measured usage (120,000 and 480,000), and a top-up has to fund the
 * limit even though only the actual is consumed, so the per-grant cap is sized
 * against the limit at the gas-price ceiling:
 *
 *   480,000 gas x 2 gwei = 0.00096 ETH
 *
 * rounded to 0.001 ETH, which is about 24 cents at 2,457 USDG/ETH. The daily and
 * lifetime caps then bound a single account to roughly 3 sponsored actions a day
 * and 10 in total, and the global cap bounds a Sybil fleet to 0.05 ETH a day
 * whatever it does.
 */
export const DEFAULT_LIMITS: SponsorLimits = {
  perGrantWei: 1_000_000_000_000_000n, // 0.001 ETH
  perUserDailyWei: 3_000_000_000_000_000n, // 0.003 ETH
  perUserLifetimeWei: 10_000_000_000_000_000n, // 0.01 ETH
  globalDailyWei: 50_000_000_000_000_000n, // 0.05 ETH
  sponsorFloorWei: 20_000_000_000_000_000n, // 0.02 ETH
  // ~4x the observed ceiling, so ordinary variance never trips it but a genuine
  // spike does.
  maxGasPriceWei: 2_000_000_000n, // 2 gwei
};

/* --------------------------------------------------------------- gwei ---- */

/**
 * Wei to gwei, rounding UP.
 *
 * The global budget counter is a Number in gwei, because `$inc` cannot operate
 * on the strings wei amounts are otherwise stored as. Rounding up rather than
 * down means the rounding error can only spend the budget faster than reality,
 * never slower — the safe direction for a cap.
 */
export function weiToGweiCeil(wei: bigint): number {
  const GWEI = 1_000_000_000n;
  return Number((wei + GWEI - 1n) / GWEI);
}
