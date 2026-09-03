import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The sponsor key is a second hot wallet that signs on its own. These assert the
 * containment that makes that acceptable, structurally rather than by review.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const rel = (file: string) => file.slice(src.length + 1).split(sep).join('/');

test('exactly one module reads the sponsor key', () => {
  // The containment claim, made checkable. If the key is only ever read in one
  // place, reasoning about where it can leak is reading one file.
  const readers = walk(src).filter((file) =>
    readFileSync(file, 'utf8').includes('SPONSOR_PRIVATE_KEY')
  );
  assert.deepEqual(readers.map(rel).sort(), ['lib/gas/boundary.test.ts', 'lib/gas/wallet.ts']);
});

test('the sponsor key is never handed out as a value', () => {
  // `withSponsorKey` takes a callback so the key is never something a caller
  // holds, stores, or returns. An accessor that returned it would undo that.
  const wallet = readFileSync(join(here, 'wallet.ts'), 'utf8');
  assert.ok(
    !/export function sponsorPrivateKey|export const sponsorPrivateKey/.test(wallet),
    'wallet.ts must not export the key itself'
  );
});

test('the sponsor key never goes through the custodial key path', () => {
  // Custodial keys are libsodium ciphertext from Mongo; the sponsor key is raw
  // hex from the environment. Keeping the paths disjoint means a refactor that
  // confuses them fails rather than signing with the wrong wallet.
  const wallet = readFileSync(join(here, 'wallet.ts'), 'utf8');
  assert.ok(!/decryptPrivateKey|encryptPrivateKey|from '.*crypto'/.test(wallet));
});

test('nothing reachable from a tweet can spend the sponsor wallet', () => {
  // An unattended cron that can drain a hot wallet is worse than a user-facing
  // one, because nobody is watching it.
  //
  // The ban is on the two modules that can SPEND — `sponsor.ts` and
  // `wallet.ts`. `policy.ts` is deliberately allowed: it is pure arithmetic,
  // it holds no key and touches no chain, and `settleTransfer` needs it to
  // subtract sponsored gas from what a wallet may send. Banning the whole
  // directory would have forced that arithmetic to be duplicated, which is how
  // two copies of a money rule start to disagree.
  const BOT_PATHS = [
    'lib/settle.ts',
    'lib/giveaway.ts',
    'lib/tip-command.ts',
    'lib/info-commands.ts',
    'app/api/twitter/poll/route.ts',
  ];
  for (const relative of BOT_PATHS) {
    const source = readFileSync(join(src, relative), 'utf8');
    for (const spender of ['gas/sponsor', 'gas/wallet']) {
      assert.ok(
        !source.includes(spender),
        `${relative} must not reach ${spender} — the bot path runs unattended`
      );
    }
  }
});

test('only the three session routes can spend the sponsor wallet', () => {
  // A whitelist, so a new caller has to be added here deliberately rather than
  // appearing because someone needed gas somewhere.
  const spenders: string[] = [];
  for (const file of walk(src)) {
    if (file.endsWith('.test.ts')) continue;
    if (rel(file).startsWith('lib/gas/')) continue;
    if (readFileSync(file, 'utf8').includes('gas/sponsor')) spenders.push(rel(file));
  }
  assert.deepEqual(spenders.sort(), [
    'app/api/fiat/payout/route.ts',
    'app/api/swap/route.ts',
    'app/api/wallet/withdraw/route.ts',
  ]);
});
