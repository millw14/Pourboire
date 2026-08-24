/**
 * Start an in-memory MongoDB, seed it with realistic data, and print the URI.
 *
 * For local verification only: it lets the profile and giveaway pages be
 * exercised end-to-end without pointing a dev server at production data. The
 * process stays alive so the database stays up; Ctrl-C tears it down.
 *
 *   node scripts/seed-dev.mjs
 */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const PORT = 37017;

const server = await MongoMemoryServer.create({ instance: { port: PORT, dbName: 'pourboire' } });
const uri = server.getUri('pourboire');
await mongoose.connect(uri);

const db = mongoose.connection.db;

/* ------------------------------------------------------------------ helpers */

const SOL = { symbol: 'SOL', mint: null, decimals: 9 };
const BONK = { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 };
const USDC = { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };

const tx = () => randomBytes(32).toString('hex').slice(0, 88);

function entry(direction, amount, token, counterparty, daysAgo) {
  return {
    type: direction === 'in' ? 'tip' : 'transfer',
    direction,
    amount,
    tokenSymbol: token.symbol,
    tokenMint: token.mint,
    tokenDecimals: token.decimals,
    counterparty,
    txHash: tx(),
    status: 'confirmed',
    date: new Date(Date.now() - daysAgo * 86_400_000),
  };
}

/* -------------------------------------------------------------------- users */

const history = [
  entry('in', '1500000000', SOL, '@satoshi', 1),
  entry('in', '500000000', SOL, '@vitalik', 2),
  entry('in', '250000000', SOL, '@satoshi', 3),
  entry('in', '100000000000', BONK, '@degen', 4),
  entry('in', '25000000', USDC, '@aeyakovenko', 5),
  entry('in', '750000000', SOL, '@satoshi', 6),
  entry('out', '300000000', SOL, 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', 7),
];

await db.collection('users').deleteMany({});
await db.collection('users').insertMany([
  {
    twitterId: '1',
    handle: '@alice',
    name: 'Alice',
    profileImage: '',
    bio: '',
    walletAddress: 'A1iceWa11etAddressForLoca1DevOn1y11111111111',
    encryptedPrivateKey: 'deadbeef',
    isEmbedded: false,
    claimed: true,
    history,
    pendingClaims: [
      {
        amount: '200000000',
        tokenSymbol: 'SOL',
        tokenMint: null,
        tokenDecimals: 9,
        fromTx: '1234567890',
        sender: '@newfan',
        createdAt: new Date(),
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    twitterId: '2',
    handle: '@nobody',
    name: 'nobody',
    profileImage: '',
    bio: '',
    walletAddress: 'N0bodyWa11etAddressForLoca1DevOn1y1111111111',
    encryptedPrivateKey: 'deadbeef',
    isEmbedded: false,
    claimed: false,
    history: [],
    pendingClaims: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
]);

/* --------------------------------------------------------------- giveaways */

// Reproduce the real draw so the verification page's recomputation agrees.
const seed = randomBytes(32).toString('hex');
const beaconHash = 'BeAc0nB1ockhashForLoca1DevOn1y11111111111111';
const entrants = Array.from({ length: 40 }, (_, i) => `@entrant${i}`);

function* stream(s, b) {
  let c = 0;
  for (;;) {
    const block = createHmac('sha256', s).update(`${b}:${c}`).digest();
    for (let o = 0; o + 4 <= block.length; o += 4) yield block.readUInt32BE(o);
    c += 1;
  }
}
function uniformBelow(g, max) {
  const limit = Math.floor(0x100000000 / max) * max;
  for (;;) {
    const v = g.next().value;
    if (v < limit) return v % max;
  }
}
const pool = [...new Set(entrants)].sort();
const g = stream(seed, beaconHash);
const count = 5;
for (let i = 0; i < count; i++) {
  const j = i + uniformBelow(g, pool.length - i);
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
const winners = pool.slice(0, count);

const total = 5_000_000_000n;
const base = total / BigInt(count);
const rem = Number(total % BigInt(count));

await db.collection('giveaways').deleteMany({});
await db.collection('giveaways').insertMany([
  {
    tweetId: '1900000000000000001',
    creatorHandle: '@alice',
    totalAmount: total.toString(),
    tokenSymbol: 'SOL',
    tokenMint: null,
    tokenDecimals: 9,
    winnerCount: count,
    closesAt: new Date(Date.now() - 3_600_000),
    seedCommitment: createHash('sha256').update(seed).digest('hex'),
    seed,
    beaconSlot: 302_144_889,
    beaconHash,
    entries: entrants,
    winners: winners.map((h, i) => ({
      handle: h,
      walletAddress: `W1nner${i}Wa11etAddress11111111111111111111111`,
      amount: (base + (i < rem ? 1n : 0n)).toString(),
    })),
    status: 'settled',
    payoutTxHashes: [tx()],
    createdAt: new Date(Date.now() - 7_200_000),
    updatedAt: new Date(),
  },
  {
    tweetId: '1900000000000000002',
    creatorHandle: '@alice',
    totalAmount: '1000000000',
    tokenSymbol: 'SOL',
    tokenMint: null,
    tokenDecimals: 9,
    winnerCount: 3,
    closesAt: new Date(Date.now() + 3_600_000),
    seedCommitment: createHash('sha256').update('pending-seed').digest('hex'),
    seed: 'pending-seed',
    entries: [],
    winners: [],
    status: 'open',
    payoutTxHashes: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  },
]);

console.log('MONGODB_URI=' + uri);
console.log('seeded: /@alice, /giveaway/1900000000000000001 (settled), /giveaway/1900000000000000002 (open)');
console.log('expected winners:', winners.join(' '));
console.log('Ctrl-C to stop.');

process.on('SIGINT', async () => {
  await mongoose.disconnect();
  await server.stop();
  process.exit(0);
});

// Keep the database alive.
setInterval(() => {}, 1 << 30);
