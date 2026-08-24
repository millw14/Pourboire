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
- A Solana RPC endpoint (the public one is rate limited to the point of uselessness)

## Setup

```bash
npm install
cp env.example .env.local
```

Fill in `.env.local`. Every variable the code reads is documented in `env.example`; the two you
must generate yourself:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # CRON_SECRET
```

Then:

```bash
npm run dev
```

`npm run build` works without a database — nothing reads configuration at module scope, so a
missing secret surfaces as a clear error on the route that needs it rather than a build failure.

## Checks

```bash
npm run check      # typecheck + lint + tests
```

## Architecture

```
src/
  app/
    page.tsx              Landing page. No providers above it, so it ships no wallet code.
    dashboard/            The only route that loads Privy + the Solana wallet adapter.
    api/
      me/                 GET  — everything the dashboard needs, one authenticated call
      wallet/withdraw/    POST — move SOL out of the caller's own tip wallet
      twitter/poll/       GET/POST — read mentions and settle tips (machine-authenticated)
  lib/
    auth.ts               Verifies Privy tokens. Identity never comes from the request body.
    api.ts                One error shape; decides what detail leaks in production.
    solana.ts             Transfers, confirmation, explorer links.
    lamports.ts           Pure lamport arithmetic (unit-tested, no dependencies).
    tip-command.ts        The tip syntax. Shared by the parser and the UI so they can't drift.
    wallets.ts            Custodial wallet lifecycle. Never overwrites an existing key.
    crypto.ts             libsodium secretbox around private keys.
  models/
    User.ts               Accounts, balances history, pending claims.
    ProcessedTweet.ts     The idempotency ledger. One payout per tweet, ever.
    PollCursor.ts         Server-side high-water mark for the mention search.
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
3. For each parsed tip, it **claims the tweet id in `ProcessedTweet` before attempting any
   transfer.** The unique index makes that atomic, so overlapping runs cannot double-send.
4. It transfers SOL from the sender's custodial wallet to the recipient's, creating the
   recipient's wallet if they've never signed up.
5. Tips that can't settle yet (sender unfunded, amount below the rent-exempt minimum) are marked
   `pending` and retried on later runs. Tips that were submitted but not confirmed are marked
   `unconfirmed` and **never retried** — the transaction may still land.

### Scheduling

`vercel.json` registers a cron for `/api/twitter/poll`. Vercel Cron sends `GET` with the
`CRON_SECRET` attached automatically. **Sub-daily crons need a Vercel Pro plan** — on Hobby the
schedule is clamped to once a day, so use an external scheduler hitting the same endpoint with
`Authorization: Bearer $CRON_SECRET` if you're on Hobby.

## Tip syntax

All of these work, case-insensitively:

```
@Pourboireonsol tip 0.5 SOL          → tips the author of the post you replied to
@Pourboireonsol tip 0.5 SOL @alice   → tips @alice
@Pourboireonsol tip @alice 0.5       → same, token defaults to SOL
```

USDC parses but is not yet settled — the bot replies saying so rather than silently doing
nothing. See `src/lib/tip-command.ts` and its tests.

## Known limitations

- **USDC tips are not implemented.** They are recognised and declined politely.
- **Rate limiting is per-instance.** `src/lib/api.ts` blunts casual abuse and runaway retry
  loops, but on serverless it is not a global limiter. Put a real one at the edge before any
  volume.
- **`programs/soltip` is not deployed or used.** It has a placeholder program id and the escrow
  PDA cannot release SOL as written. Treat it as a sketch, not a component.
- **The server holds custodial keys.** Moving unclaimed tips into an on-chain escrow would remove
  the largest risk in the system; that work has not been done.

## License

MIT.
