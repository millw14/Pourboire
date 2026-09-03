# Making a tip spendable without a licence

Status: decided, 2026-09-03. Supersedes the Phase 1b reasoning in the
"Local currency everywhere, and a USD card" plan.

Turning a stablecoin balance into local money, or issuing a card that spends it,
is money transmission. It needs a licensed partner, and that partner is signed
rather than coded. This document is about the part that does **not** need one,
and about a route we are declining — with the reasons corrected, because two of
the ones originally written down turned out to be false.

## What ships: the swap path

Swapping USDG into a tokenised asset is a trade the user initiates, on-chain,
from their own custodial balance. Not money transmission, no KYC, no contract.
Uniswap V3 is deployed on Robinhood Chain and the NVDA/USDG pool at the 0.05%
tier holds roughly 4.8M USDG and 5,950 NVDA, so the liquidity is real.

It is deliberately **dashboard-only and user-initiated**. Auto-selling someone's
holdings because they tweeted a word is a trade they did not authorise, and
`src/lib/fiat/boundary.test.ts` now asserts structurally that nothing reachable
from a tweet imports the swap layer.

The matching exclusion is enforced in code rather than prose: a payout may never
sell an equity to fund itself. See `src/lib/fiat/settlement-token.ts`.

## What we are declining: x402

x402 is real and large — Linux Foundation since July 2026 — and it settles
USDC/EURC via EIP-3009. The plan gave two reasons it could not reach this chain.
**Both were wrong**, and the corrections are recorded here so nobody rebuilds the
argument from the old premises.

### Correction 1 — USDG does implement EIP-3009

The plan left this open, noting that a bytecode grep of the EIP-1967
implementation found no `transferWithAuthorization`.

That test was invalid. USDG is a diamond: its unknown-selector error is
`FacetNotFound()`, and the EIP-3009 code lives in facets that are not in the core
implementation's bytecode. Probing by behaviour instead of by grep settles it —
a correctly-signed `transferWithAuthorization` succeeds under `eth_call`, a
corrupted signature returns `InvalidSignature()`, an expired window returns
`AuthorizationExpired()`, and both `DOMAIN_SEPARATOR()` and
`authorizationState(address,bytes32)` answer.

The plan also asserted this RPC strips revert data. It does not — it returns
custom-error revert data, which is what made the probe decisive. (It is not an
archive node, though: historical `eth_getCode` and `eth_getStorageAt` fail.)

### Correction 2 — USDC is on this chain

The plan said Robinhood Chain carries no USDC. It carries genuine Circle
FiatTokenV2 USDC at `0x3884564ba51b349e7661c7e28ad947dee327fedf` — verified
directly: `symbol()` USDC, `version()` 2, 6 decimals, CCTP wired to 27 remote
domains.

Its **total supply is 2.94 USDC** and it has no DEX pool. So it is bridgeable and
not tradeable.

No EURC was found by any method tried, but that negative is weaker: what was
actually established is that CCTP's TokenMinter links only USDC, that EURC does
not appear among the most-pooled tokens in a full enumeration of 426,178
`PoolCreated` events, and that the canonical Ethereum, Base and Avalanche EURC
addresses have no code here.

### So why decline it

Not because it is impossible. Because:

1. **No x402 facilitator supports chain 4663.** Settlement would have nowhere to
   verify against, and that is not something this repo can fix.
2. **The USDC float is 2.94 tokens with zero liquidity.** Nothing to spend.
3. **It does not serve the stated goal anyway.** x402's catalogue is APIs and
   agent services. Someone tipped $5 who wants to pay a bill is not looking to
   buy an inference call.

The decision is the same as the plan's. The reason is materially different —
"unsupported and unfunded" rather than "impossible" — and that is worth knowing,
because the first can change without anyone rebuilding a chain.

*What would change it:* an x402 facilitator adding chain 4663, or USDC gaining
real float and a pool here. Both are outside our control. Neither is worth
waiting for.

*Where x402 would genuinely fit, later:* the **earning** side — a creator putting
an x402 paywall on their own content and collecting into the same tip wallet.
That is a different feature and should be judged on its own merits rather than
smuggled in as "spending".

## Why there is no testnet proof

The plan's verification section promised an end-to-end testnet swap. **That is
not possible.** Robinhood Chain testnet (46630) hosts none of it — not the nine
registry tokens, not the V3 factory, not SwapRouter02 — and the address registry
is hardcoded to mainnet with no network-awareness to point elsewhere. A testnet
run would read zeros and report success, which is worse than not running it.

What replaces it is `scripts/verify-swap-live.ts`: the shipped `resolvePool` and
`quoteSwap` run against the real factory, the real pool and real balances, and
their output is checked against the pool's own reserves and an independent
recomputation, in both trade directions. It signs nothing and touches no key.

```
node --experimental-strip-types --conditions=react-server scripts/verify-swap-live.ts
```

This is not theatre — it found a real defect on its first run. `resolvePool` was
swallowing per-fee-tier RPC errors, so a single dropped request silently dropped
a whole tier from consideration. One run selected the 0.3% pool holding 50 NVDA
over the 0.05% pool holding 5,946, a hundredfold difference in depth, and
returned a perfectly ordinary-looking quote. It now retries once and refuses
rather than quoting from a partial comparison.

**The write path is still unproven.** Approve and `exactInputSingle` cannot be
exercised without a real mainnet transaction. Gas is around 0.5 gwei, so a
one-dollar USDG swap would settle it — but that is real money in a custodial
wallet, and it is the owner's call to make, not ours.

## Gas: the reason none of the above worked

Everything above assumes the holder can move their own money. Until now they
could not.

A tip mints a custodial wallet and sends it USDG. Nothing anywhere funded ETH,
and on an EVM chain you cannot spend a token you own without gas — so the person
this product is built for, the one who was tipped and had never heard of us,
held a balance they could not withdraw, could not swap, and could not cash out.
`/api/me` has called this "the state people actually get stuck in" since the
chain migration. The swap path made it worse: a swap is two transactions.

So the app now covers the shortfall, from a sponsor wallet that holds ETH and
nothing else. It is off unless `SPONSOR_PRIVATE_KEY` is set, and with it unset
the behaviour is exactly what it was before.

### What it costs

Measured on this chain rather than assumed — gas is around 0.47 gwei, and ETH
prices at about 2,457 USDG across three on-chain WETH/USDG pools:

| action | gas | cost |
|---|---|---|
| USDG transfer | 48,436 | $0.06 |
| approve | 58,572 | $0.07 |
| `exactInputSingle` | 175,085 | $0.22 |
| a whole swap | 233,657 | $0.29 |

Sponsorship is a rounding error, so the design optimises for blast radius rather
than for efficiency.

### What stops it being a faucet

The obvious failure is that a top-up is just free money. Four things prevent it,
and the first is the one that matters:

1. **Sponsored ETH cannot be withdrawn.** `withdraw {"token":"ETH"}` and
   `tip 0.001 ETH @someone` settle through the same native branch, so without
   this the sponsor is a faucet with a withdraw button — put ETH in, take ETH
   out, lose only the 21,000 gas of the withdrawal. An outstanding grant is
   subtracted from what the wallet may send, and ratchets down only as the
   balance falls.
2. **The grant is the shortfall, never a fixed amount.** A grant that went
   unused is still in the wallet, so it reduces the next one to zero. An idle
   loop stops paying out after the first grant without having to detect that it
   is a loop.
3. **Only a signed-in account is eligible.** A tweet mints a custodial wallet
   for any handle it names, so "a user row exists" costs an attacker nothing. A
   Privy identity is the cheapest thing here that is not free.
4. **Caps at three levels**, bounding one account to 0.01 ETH for life and
   everyone together to 0.05 ETH a day. The global one is a single filtered
   `$inc` where a miss *is* the refusal — `rateLimit()` could not do this job,
   because its own comment says it is per-warm-instance and Vercel will happily
   run many.

### What it deliberately does not do

**The bot cannot reach it.** Tips, rain and giveaways run unattended on a cron,
and an unattended loop that can drain a hot wallet is worse than a user-facing
one because nobody is watching it. Sponsorship is invoked from three session
routes only — withdraw, swap, payout — and a test asserts that list is exactly
those three, and that nothing on the tweet-driven path imports the modules that
can spend.

**The key never leaves one file.** `lib/gas/wallet.ts` is the only module that
reads `SPONSOR_PRIVATE_KEY`, and it hands out a callback rather than the key, so
there is no value for a caller to hold, store, or log. It is raw hex from the
environment, deliberately a different shape in a different place from the
libsodium-wrapped custodial keys, so a refactor that confuses the two fails
rather than quietly signing with the wrong wallet. Three tests hold that shape.

### The alternative, and why not yet

USDG implements EIP-3009, so the custodial key could sign a
`transferWithAuthorization` and the sponsor could submit it and pay the gas —
no ETH would ever reach a user wallet, and there would be no drain vector at
all. It is genuinely the better mechanism for a transfer, and it has a second
benefit worth recording: `validBefore` turns the unresolvable `unknown` state
into a bounded one, because once the deadline passes and `authorizationState`
still reads false, the money provably did not move.

It is not built because it cannot serve a swap. The router pulls `tokenIn` from
`msg.sender`, so a relayed call would be spending the relayer's tokens, not the
user's. Top-up is needed for that path regardless — and adding a relay first
would not remove the risky mechanism, only delay it while doubling the surface
to maintain.
