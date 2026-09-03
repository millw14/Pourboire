import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The line the whole product rests on: **receiving needs no identity.**
 *
 * A tip lands for an X handle whose owner has never heard of us, a custodial
 * wallet is minted for them, and none of that involves KYC. Paying out does, and
 * that asymmetry is easy to erode by accident — one convenient import from a
 * settlement path into the fiat directory and suddenly the tip flow has an
 * identity dependency nobody decided to add.
 *
 * So it is asserted structurally rather than trusted to review.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..');

/** Paths that must stay entirely free of the fiat layer. */
const RECEIVING_PATHS = [
  'lib/settle.ts',
  'lib/giveaway.ts',
  'lib/wallets.ts',
  'lib/tip-command.ts',
  'app/api/twitter/poll/route.ts',
];

test('nothing on the receiving path imports the fiat layer', () => {
  for (const relative of RECEIVING_PATHS) {
    const source = readFileSync(join(src, relative), 'utf8');
    const offending = source
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line) && /fiat\//.test(line));
    assert.deepEqual(
      offending,
      [],
      `${relative} must not import the fiat layer — receiving needs no identity`
    );
  }
});

test('the fiat layer does not reach back into the poller', () => {
  // The other direction matters too: a fiat module importing the poller would
  // make the two deployable units one, and the tip path is the one that must
  // keep working when payouts are broken.
  for (const file of walk(here)) {
    if (file.endsWith('.test.ts')) continue;
    const source = readFileSync(file, 'utf8');
    assert.ok(
      !/from '.*app\/api\/twitter/.test(source),
      `${file} must not import the poller`
    );
  }
});

test('every testable fiat module imports its neighbours with a .ts extension', () => {
  // Node's test runner does not resolve extensionless relative imports, so an
  // extensionless one silently removes a module from the suite rather than
  // failing — which is how the swap tests went unrun once already.
  //
  // Only modules the runner can load at all are checked. A `server-only` module
  // throws on import there regardless, so its import style cannot hide anything.
  for (const file of walk(here)) {
    const contents = readFileSync(file, 'utf8');
    if (contents.includes("import 'server-only'")) continue;
    for (const line of contents.split('\n')) {
      const match = /^\s*import\s+(?:type\s+)?.*from\s+'(\.\/[^']+)'/.exec(line);
      if (!match) continue;
      assert.ok(
        match[1]!.endsWith('.ts'),
        `${file}: relative import ${match[1]} needs a .ts extension`
      );
    }
  }
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}
