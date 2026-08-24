# Pourboire

Tip anyone on X with Solana. Reply to a post with `@Pourboireonsol tip 0.5 SOL` and the author
gets the SOL — no wallet needed on their side. If they haven't signed up, the tip lands in a
custodial wallet that becomes theirs when they do.

---

## ⚠️ Read this before deploying

This app holds **private keys for its users** in MongoDB, encrypted with a single symmetric key.
That design puts a lot of weight on two things:

1. **`ENCRYPTION_KEY` must never leak, and must never be lost.** Leaking it plus a database dump
   is total compromise of every custodial wallet. Losing it makes every custodial wallet
   permanently unspendable. Back it up somewhere other than the machine running the app.
2. **Every route that can move money must verify the caller.** They all do now (see
   [Authentication](#authentication)), but this is the invariant to protect in review.

If you are picking this repo up after October 2025, assume the keys in any pre-existing database
are compromised — the withdrawal endpoint was reachable without authentication, so plaintext keys
were exposed through the API rather than through the ciphertext. Sweep to fresh keypairs; rotating
`ENCRYPTION_KEY` alone is not sufficient.

---

## Requirements

- Node.js 20+
- A MongoDB database
- A Privy app (authentication) — https://dashboard.privy.io
- X/Twitter API credentials for the bot account
- A Solana RPC endpoint that serves `getBlock` (the public one is rate limited to the point of
  uselessness, and giveaway draws need `getBlock` specifically)

## Setup

```bash
npm install
cp env.example .env.local
```

Fill in `.env.local`. Every variable the code reads is documented in `env.example`; the two you
must generate yourself:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run that twice — once for `ENCRYPTION_KEY`, once for `CRON_SECRET`. Then:

```bash
npm run dev
```

`npm run build` works without a database — nothing reads configuration at module scope, so a
missing secret surfaces as a clear error on the route that needs it rather than a build failure.

## Checks

```bash
npm run check
```

Typecheck, lint and tests. For local UI work against realistic data without touching a real
database:

```bash
node scripts/seed-dev.mjs
```

That starts an in-memory MongoDB on port 37017 and seeds a profile and two giveaways. Point
`MONGODB_URI` at the printed URI.

## Architecture

```
src/
  app/
    page.tsx              Landing page. No providers above it, so it ships no wallet code.
    [handle]/             Public creator profiles: /@alice
    giveaway/[id]/        Public giveaway verification
    dashboard/            The only route that loads Privy + the Solana wallet adapter
    api/
      me/                 GET  — everything the dashboard needs, one authenticated call
      wallet/withdraw/    POST — move SOL out of the caller's own tip wallet
      wallet/swap/        GET quote, POST execute — Jupiter, inside the caller's wallet
      og/tip/             GET  — HMAC-signed receipt card images
      twitter/poll/       GET/POST — settle tips and giveaways (machine-authenticated)
  lib/
    auth.ts               Verifies Privy tokens. Identity never comes from the request body.
    api.ts                One error shape; decides what detail leaks in production.
    tokens.ts             Token registry and exact decimal conversion.
    lamports.ts           Pure lamport arithmetic (unit-tested, no dependencies).
    solana.ts             Native transfers, confirmation, the draw beacon, explorer links.
    spl.ts                SPL transfers, associated-token-account handling.
    settle.ts             "Can the sender afford this, and what does it cost them."
    draw.ts               Provably-fair winner selection.
    giveaway.ts           Giveaway lifecycle: open, draw, pay.
    jupiter.ts            Swap quotes and execution. Dashboard-only, never the bot.
    receipt.ts            HMAC signing for receipt card parameters.
    tip-command.ts        The command syntax. Shared by the parser and the UI so they can't drift.
    wallets.ts            Custodial wallet lifecycle. Never overwrites an existing key.
    crypto.ts             libsodium secretbox around private keys.
  models/
    User.ts               Accounts, history, pending claims.
    ProcessedTweet.ts     The idempotency ledger. One payout per tweet, ever.
    PollCursor.ts         Server-side high-water mark for the mention search.
    Giveaway.ts           Commitment, beacon, entries, winners.
```

### Authentication

| Caller | Mechanism |
| --- | --- |
| A signed-in person | Privy access token in `Authorization: Bearer`, verified against Privy, resolved to an account by immutable Twitter subject id — never by handle, which is renameable and spoofable. |
| The scheduler | `CRON_SECRET` bearer token, compared in constant time. If the variable is unset the endpoint refuses every request rather than defaulting to open. |

No route accepts an account identifier from its request body.

### How tips settle

1. Vercel Cron calls `/api/twitter/poll` (see `vercel.json`).
2. The poller searches for mentions newer than the stored `PollCursor`.
3. For each parsed command, it **claims the tweet id in `ProcessedTweet` before attempting
   anything.** The unique index makes that atomic, so overlapping runs cannot double-send.
4. It transfers from the sender's custodial wallet to the recipient's, creating the recipient's
   wallet if they've never signed up.
5. Tips that can't settle yet (sender unfunded, amount below the rent-exempt minimum) are marked
   `pending` and retried on later runs. Tips that were submitted but not confirmed are marked
   `unconfirmed` and **never retried** — the transaction may still land.

### Scheduling

`vercel.json` registers a cron for `/api/twitter/poll`. Vercel Cron sends `GET` with the
`CRON_SECRET` attached automatically. **Sub-daily crons need a Vercel Pro plan** — on Hobby the
schedule is clamped to once a day, so use an external scheduler hitting the same endpoint with
`Authorization: Bearer $CRON_SECRET` if you're on Hobby.

---

## Commands

All case-insensitive. `@Pourboire` also works as a shorter form of the bot handle.

### Tips

```
@Pourboireonsol tip 0.5 SOL                tips the author of the post you replied to
@Pourboireonsol tip 0.5 SOL @alice         tips @alice
@Pourboireonsol tip @alice 0.5             same, token defaults to SOL
@Pourboireonsol tip 100000 BONK            any token in the registry
@Pourboireonsol tip 5 <mint address>       any SPL token, by mint
@Pourboireonsol tip 1 SOL each @a @b @c    the full amount to each of them
@Pourboireonsol split 3 SOL @a @b @c       one amount divided between them
```

Symbols resolve against a curated registry in `src/lib/tokens.ts` — deliberately not Jupiter's
full list, where most entries are scams sharing a symbol with something real. Anything outside
the registry must be tipped by mint address, where the sender has already decided which token
they mean.

The first SPL tip to someone who has never held that token opens an account for them, and the
**sender** pays its rent (~0.00204 SOL). The bot says so rather than letting the transaction fail.

### Giveaways

```
@Pourboireonsol giveaway 5 SOL to 10 in 2h
@Pourboireonsol giveaway 1 SOL to 3 people in 30m
@Pourboireonsol giveaway 10 USDC to 5 winners in 1d
```

Windows run from 5 minutes to 7 days. The ceiling sits inside X's seven-day search window, which
is how entries are collected.

## How the giveaway draw works

Three steps, and the *order* is what makes it verifiable:

1. **Commit.** When the giveaway opens, a random seed is generated and only its SHA-256 hash is
   published, in the announcement tweet. A hash reveals nothing about the draw.
2. **Beacon.** When the window closes, the blockhash of a finalised Solana slot is taken. That
   value did not exist at commit time, so the seed cannot have been chosen to favour anyone.
3. **Reveal.** The seed is published. `HMAC-SHA256(seed, beacon)` drives a Fisher-Yates shuffle
   over the sorted entry list, with rejection sampling so no index is favoured by modulo bias.

Neither side can steer it alone: we pick the seed but not the beacon, and the chain never sees
the seed. Grinding the beacon would mean rewriting Solana history.

`/giveaway/<tweetId>` publishes the commitment, the seed, the slot, the blockhash, the full entry
list and the algorithm — and **re-runs the draw server-side**, displaying a mismatch rather than
hiding it. A verification page that cannot fail verifies nothing.

Implementation in `src/lib/draw.ts`; the properties are pinned in `src/lib/draw.test.ts`,
including reproducibility, resistance to modulo bias, and that prize remainders are distributed
rather than stranded.

## Receipt cards

Every bot reply carries a generated 1200×630 card instead of a sentence. `/api/og/tip` renders
it, and every parameter set is **HMAC-signed** — without that it would be an open generator for
authentic-looking Pourboire receipts showing any amount between any two handles, which is a
ready-made scam tool. Unsigned or tampered parameters return 404.

## Creator pages

`pourboire.tips/@handle` shows totals per token, top tippers, giveaways run, and recent tips.

**Only received tips are shown.** Every one was already announced publicly on X by the bot, so
the page discloses nothing new. Withdrawals, transfers out, balances and pending claims are
deliberately never rendered — an earlier version of this app leaked exactly that by wallet
address, and it is not worth reintroducing for a leaderboard.

## Known limitations

- **Swaps are dashboard-only.** Jupiter is wired into `/api/wallet/swap` for converting balances
  by hand. It is deliberately *not* wired into the tip bot: auto-selling someone's SOL because
  they tweeted "tip 100k BONK" would mean silently trading at whatever slippage the route
  carries, triggered by a tweet.
- **Jupiter's API host has moved before.** `JUPITER_API_URL` overrides it; the default is their
  current free-tier endpoint.
- **Giveaway entries cost X API quota.** Collecting every reply to a thread is the most expensive
  call the bot makes. Check your tier's limits before promoting the feature.
- **Rate limiting is per-instance.** `src/lib/api.ts` blunts casual abuse and runaway retry
  loops, but on serverless it is not a global limiter. Put a real one at the edge before any
  volume.
- **`programs/soltip` is not deployed or used.** It has a placeholder program id and the escrow
  PDA cannot release SOL as written. Treat it as a sketch, not a component.
- **The server holds custodial keys.** Moving unclaimed tips into an on-chain escrow would remove
  the largest risk in the system; that work has not been done.

## License

MIT.
