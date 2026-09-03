import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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
 * Every module specifier in a file, via the TypeScript compiler.
 *
 * This started as a line-by-line match, which a multi-line import evaded — and
 * multi-line is how the poller imports everything, so it reported green on a
 * boundary a four-line import would have broken.
 *
 * It was then a single regex over the whole file, which was worse in a quieter
 * way: the optional clause before `from` was unanchored, so a bare
 * `import '@/lib/swap/router';` was swallowed whole by the next import that did
 * have a `from`. The forbidden specifier never appeared in the output at all —
 * a test that reads as strict and sees nothing.
 *
 * Two wrong regexes is the signal to stop writing regexes. `preProcessFile` is
 * the compiler's own scanner: it sees every import and export form, and it
 * ignores text in comments and template literals, which no expression of this
 * shape reliably does.
 */
function specifiersIn(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);
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
  // vacuously green — which has now happened twice, in two different ways.
  //
  // Ordering matters here and is deliberate. The previous regex swallowed a bare
  // `import '…'` into whatever import came AFTER it, so a sample that ended with
  // the bare and dynamic forms could not observe its own blind spot. The
  // side-effect import is therefore followed by a normal one, which is exactly
  // the arrangement that used to fail.
  const sample = [
    "import { a } from './one';",
    "import {\n  b,\n  c,\n} from './two';",
    "import type {\n  d,\n} from './three';",
    "export { e } from './four';",
    "export * from './five';",
    "import './six';",
    "import { seven } from './seven';",
    "const h = await import('./eight');",
    "import nine, { ten as t } from './nine';",
    "import * as eleven from './eleven';",
  ].join('\n');
  assert.deepEqual(specifiersIn(sample), [
    './one',
    './two',
    './three',
    './four',
    './five',
    './six',
    './seven',
    './eight',
    './nine',
    './eleven',
  ]);
});

test('the matcher does not invent imports from comments or strings', () => {
  // A false positive is the other way this test stops being usable: it would
  // fail on a file that merely mentions the forbidden path in a comment, and the
  // fix people reach for then is to loosen the assertion.
  const sample = [
    "// import { fake } from '@/lib/swap/router';",
    "/* import '@/lib/fiat/payouts'; */",
    "const s = `from '@/lib/swap/router'`;",
    "const t = \"@/lib/swap/router\";",
    "import { real } from './real';",
  ].join('\n');
  assert.deepEqual(specifiersIn(sample), ['./real']);
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

test('every testable module imports its neighbours with a .ts extension', () => {
  // Node's test runner does not resolve extensionless relative imports, so an
  // extensionless one silently removes a module from the suite rather than
  // failing — which is how the swap tests went unrun once already. So the swap
  // directory is covered here too, not just this one.
  //
  // Only modules the runner can load at all are checked. A `server-only` module
  // throws on import there regardless, so its import style cannot hide anything.
  // That exemption is decided by the module's actual imports rather than by
  // searching its text, so a file that merely mentions the phrase in a comment
  // is still checked.
  for (const dir of [here, join(src, 'lib', 'swap')]) {
    for (const file of walk(dir)) {
      const contents = readFileSync(file, 'utf8');
      const specifiers = specifiersIn(contents);
      if (specifiers.includes('server-only')) continue;
      for (const specifier of specifiers) {
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
        assert.ok(
          specifier.endsWith('.ts'),
          `${file}: relative import ${specifier} needs a .ts extension`
        );
      }
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
