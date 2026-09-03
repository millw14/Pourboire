import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Two lines the product rests on, asserted structurally rather than trusted to
 * review.
 *
 * **Receiving needs no identity.** A tip lands for an X handle whose owner has
 * never heard of us, a custodial wallet is minted for them, and none of that
 * involves KYC. Paying out does. One convenient import from a settlement path
 * into the fiat directory and the tip flow acquires an identity dependency
 * nobody decided to add.
 *
 * **The bot never trades.** Swaps are dashboard-only and user-initiated,
 * because auto-selling someone's holdings in response to a tweet is a trade they
 * did not authorise.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..');

/**
 * Every module specifier in a file, however it is written.
 *
 * The first version of this matched line by line and required the line to both
 * start with `import` and contain the specifier — which a multi-line import
 * evades, and multi-line is how the poller imports everything. It reported green
 * on a boundary a four-line import would have broken. One regex over the whole
 * source covers `import … from`, `export … from`, bare `import '…'`, and
 * `import('…')`, in any layout.
 */
const SPECIFIER = /(?:^|[\s;}])(?:import|export)\s*(?:[\s\S]*?\sfrom\s*|\(\s*)?['"]([^'"]+)['"]/g;

function specifiersIn(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) found.push(match[1]!);
  return found;
}

/** Paths that must stay entirely free of the fiat layer. */
const RECEIVING_PATHS = [
  'lib/settle.ts',
  'lib/giveaway.ts',
  'lib/wallets.ts',
  'lib/tip-command.ts',
  'app/api/twitter/poll/route.ts',
];

/**
 * Paths reachable from a tweet. None may reach the swap layer.
 *
 * Worded precisely: the claim is that the bot path cannot reach the swap layer
 * or construct router calldata — NOT that the bot never causes a contract call.
 * It does: `resolveToken` accepts a bare contract address from a tweet and
 * `transfer()` then sends the ERC-20 transfer selector to it. That is a narrower
 * and defensible guarantee, and stating the wider one would mislead the next
 * reader into thinking a guard exists that does not.
 */
const BOT_PATHS = [
  'lib/settle.ts',
  'lib/giveaway.ts',
  'lib/tip-command.ts',
  'lib/info-commands.ts',
  'app/api/twitter/poll/route.ts',
];

const FIAT_IMPORT = /(^|\/)lib\/fiat(\/|$)/;
const SWAP_IMPORT = /(^|\/)(lib\/swap|api\/swap)(\/|$)/;

test('the module-specifier matcher sees every import shape', () => {
  // The detector is the test. If it misses a shape, every assertion below is
  // vacuously green — which is what happened when it matched line by line.
  const sample = [
    "import { a } from './one';",
    "import {\n  b,\n  c,\n} from './two';",
    "import type {\n  d,\n} from './three';",
    "export { e } from './four';",
    "export * from './five';",
    "import './six';",
    "const g = await import('./seven');",
  ].join('\n');
  assert.deepEqual(specifiersIn(sample), [
    './one',
    './two',
    './three',
    './four',
    './five',
    './six',
    './seven',
  ]);
});

test('nothing on the receiving path imports the fiat layer', () => {
  for (const relative of RECEIVING_PATHS) {
    const offending = specifiersIn(readFileSync(join(src, relative), 'utf8')).filter((s) =>
      FIAT_IMPORT.test(s)
    );
    assert.deepEqual(
      offending,
      [],
      `${relative} must not import the fiat layer — receiving needs no identity`
    );
  }
});

test('nothing reachable from a tweet imports the swap layer', () => {
  for (const relative of BOT_PATHS) {
    const offending = specifiersIn(readFileSync(join(src, relative), 'utf8')).filter((s) =>
      SWAP_IMPORT.test(s)
    );
    assert.deepEqual(
      offending,
      [],
      `${relative} must not reach the swap layer or construct router calldata — a trade has to be one the user asked for`
    );
  }
});

test('the swap layer is imported by exactly one route, and it is the dashboard one', () => {
  // Stated as a whitelist rather than a blacklist: a new server file importing
  // the router has to be added here deliberately.
  const importers: string[] = [];
  for (const file of walk(join(src, 'app'))) {
    if (file.endsWith('.test.ts')) continue;
    if (specifiersIn(readFileSync(file, 'utf8')).some((s) => /(^|\/)lib\/swap(\/|$)/.test(s))) {
      importers.push(file.slice(src.length + 1).split(sep).join('/'));
    }
  }
  assert.deepEqual(importers, ['app/api/swap/route.ts']);
});

test('the fiat layer does not reach back into the poller', () => {
  // The other direction matters too: the tip path must keep working when payouts
  // are broken, and that means they cannot be one deployable unit.
  for (const file of walk(here)) {
    if (file.endsWith('.test.ts')) continue;
    const offending = specifiersIn(readFileSync(file, 'utf8')).filter((s) =>
      /api\/twitter/.test(s)
    );
    assert.deepEqual(offending, [], `${file} must not import the poller`);
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
    for (const specifier of specifiersIn(contents)) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      assert.ok(
        specifier.endsWith('.ts'),
        `${file}: relative import ${specifier} needs a .ts extension`
      );
    }
  }
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}
