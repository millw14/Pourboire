import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommand,
  parseTipCommand,
  exampleCommand,
  exampleGiveaway,
  exampleRain,
  BOT_HANDLE,
  RAIN_DEFAULT_RECIPIENTS,
  RETIRED_SYMBOLS,
  HELP_COMMANDS,
  retiredSymbolIn,
} from './tip-command.ts';

/**
 * The parser decides whether real money moves, so every case that used to be
 * silently dropped is pinned here.
 */

/* ------------------------------------------------------------------- tips */

test('parses the command the homepage teaches', () => {
  // This exact string was unparseable before: the tutorial said "@Pourboire"
  // while the regex demanded "@pourboireonsol" plus an explicit @recipient.
  assert.deepEqual(parseTipCommand('@Pourboire tip 0.5 USDG'), {
    kind: 'tip',
    amount: '0.5',
    token: 'USDG',
    recipientHandle: null,
    mode: 'single',
    recipients: [],
  });
});

test('the documented examples are parseable', () => {
  assert.equal(parseCommand(exampleCommand(0.5))?.kind, 'tip');
  assert.equal(parseCommand(exampleGiveaway())?.kind, 'giveaway');
});

test('parses amount, token, then recipient', () => {
  const c = parseTipCommand('@Pourboireonsol tip 1.25 USDG @alice');
  assert.equal(c?.amount, '1.25');
  assert.equal(c?.recipientHandle, '@alice');
});

test('parses recipient before amount', () => {
  const c = parseTipCommand('@Pourboireonsol tip @bob 2 eth');
  assert.equal(c?.amount, '2');
  assert.equal(c?.token, 'ETH');
  assert.equal(c?.recipientHandle, '@bob');
});

test('defaults to USDG when no token is given', () => {
  assert.equal(parseTipCommand('@Pourboireonsol tip 0.1 @carol')?.token, 'USDG');
});

test('is case insensitive and normalises handles', () => {
  assert.equal(parseTipCommand('@POURBOIREONSOL TIP 1 USDG @DaVe')?.recipientHandle, '@dave');
});

test('reads a command that appears mid-tweet', () => {
  assert.equal(parseTipCommand('great post! @Pourboireonsol tip 0.2 USDG')?.amount, '0.2');
});

test('refuses to tip the bot itself', () => {
  assert.equal(parseTipCommand('@Pourboireonsol tip 1 USDG @Pourboireonsol')?.recipientHandle, null);
});

test('rejects text that is not a command', () => {
  assert.equal(parseCommand('@Pourboireonsol what is this'), null);
  assert.equal(parseCommand('@Pourboireonsol tip me please'), null);
  assert.equal(parseCommand('just a normal tweet'), null);
});

test('rejects a zero amount', () => {
  assert.equal(parseCommand('@Pourboireonsol tip 0 USDG @alice'), null);
});

test('an unrecognised word in the token position refuses the whole command', () => {
  // This is the fix for the worst bug the migration introduced. When SOL/BONK
  // stopped being known symbols they stopped matching the token pattern, the
  // command fell through to the bare "amount only" form, and `tip 100000 BONK`
  // was read as 100,000 USDG with the recipient discarded.
  //
  // Anything token-shaped that we do not recognise now refuses the command
  // outright. Refusing costs one no-op reply; accepting cost the balance.
  assert.equal(parseCommand('@Pourboireonsol tip 100000 BONK'), null);
  assert.equal(parseCommand('@Pourboireonsol tip 0.5 SOL @alice'), null);
  assert.equal(parseCommand('@Pourboireonsol tip 5 FOOBAR @alice'), null);
  assert.equal(parseCommand('@Pourboireonsol tip 0.5 ethereal'), null);

  // The same rule across every command shape that takes a token.
  assert.equal(parseCommand('@Pourboireonsol split 3 SOL @a @b'), null);
  assert.equal(parseCommand('@Pourboireonsol rain 5 SOL'), null);
  assert.equal(parseCommand('@Pourboireonsol giveaway 5 SOL to 10 in 2h'), null);
});

test('a bare amount with no token still defaults to USDG', () => {
  // The default applies only when no token word was written at all — never as a
  // substitute for one we failed to recognise.
  const c = parseTipCommand('@Pourboireonsol tip 0.5');
  assert.equal(c?.token, 'USDG');
  assert.equal(c?.amount, '0.5');
});

test('every symbol retired by the chain move is detectable for the reply', () => {
  // So the bot can explain itself rather than going silent on people who
  // learned the old syntax.
  for (const symbol of RETIRED_SYMBOLS) {
    assert.equal(
      retiredSymbolIn(`@Pourboireonsol tip 5 ${symbol} @alice`),
      symbol,
      `${symbol} should be recognised as retired`
    );
  }
  assert.equal(retiredSymbolIn('@Pourboireonsol tip 5 USDG @alice'), null);
  assert.equal(retiredSymbolIn('just a tweet mentioning SOL'), null);
});

/* ----------------------------------------------------------- token support */

test('parses tokenised equity symbols', () => {
  const c = parseTipCommand('@Pourboireonsol tip 100000 NVDA @alice');
  assert.equal(c?.token, 'NVDA');
  assert.equal(c?.amount, '100000');
});

test('strips thousands separators from amounts', () => {
  assert.equal(parseTipCommand('@Pourboireonsol tip 1,000,000 NVDA @alice')?.amount, '1000000');
});

test('accepts a raw contract address and preserves its casing', () => {
  // EIP-55 encodes the checksum in the letter casing, so upper-casing an
  // address destroys the one check that catches a mistyped one.
  const mint = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
  const c = parseTipCommand(`@Pourboireonsol tip 5 ${mint} @alice`);
  assert.equal(c?.token, mint);
});

/* ------------------------------------------------------ multiple recipients */

test('tips several people the same amount', () => {
  const c = parseTipCommand('@Pourboireonsol tip 1 USDG each @a @b @c');
  assert.equal(c?.mode, 'each');
  assert.deepEqual(c?.recipients, ['@a', '@b', '@c']);
});

test('splits one amount between several people', () => {
  const c = parseTipCommand('@Pourboireonsol split 3 USDG @a @b @c');
  assert.equal(c?.mode, 'split');
  assert.equal(c?.recipients.length, 3);
});

test('deduplicates repeated recipients', () => {
  const c = parseTipCommand('@Pourboireonsol tip 1 USDG each @a @a @b');
  assert.deepEqual(c?.recipients, ['@a', '@b']);
});

test('excludes the bot from a recipient list', () => {
  const c = parseTipCommand('@Pourboireonsol tip 1 USDG each @a @Pourboireonsol @b');
  assert.deepEqual(c?.recipients, ['@a', '@b']);
});

/* ------------------------------------------------------------- giveaways */

test('parses a giveaway with hours', () => {
  assert.deepEqual(parseCommand('@Pourboireonsol giveaway 5 USDG to 10 in 2h'), {
    kind: 'giveaway',
    amount: '5',
    token: 'USDG',
    winners: 10,
    durationMinutes: 120,
  });
});

test('parses a giveaway with the word "people" and minutes', () => {
  const g = parseCommand('@Pourboireonsol giveaway 1 USDG to 3 people in 30m');
  assert.equal(g?.kind, 'giveaway');
  assert.equal(g?.kind === 'giveaway' && g.durationMinutes, 30);
});

test('parses a giveaway in days', () => {
  const g = parseCommand('@Pourboireonsol giveaway 10 NVDA to 5 winners in 1d');
  assert.equal(g?.kind === 'giveaway' && g.durationMinutes, 1440);
  assert.equal(g?.kind === 'giveaway' && g.token, 'NVDA');
});

test('rejects giveaway windows that are too short or too long', () => {
  assert.equal(parseCommand('@Pourboireonsol giveaway 5 USDG to 10 in 1m'), null);
  assert.equal(parseCommand('@Pourboireonsol giveaway 5 USDG to 10 in 30d'), null);
});

test('rejects an absurd winner count', () => {
  assert.equal(parseCommand('@Pourboireonsol giveaway 5 USDG to 0 in 2h'), null);
  assert.equal(parseCommand('@Pourboireonsol giveaway 5 USDG to 500 in 2h'), null);
});

test('a giveaway is not read as a tip', () => {
  assert.equal(parseTipCommand('@Pourboireonsol giveaway 5 USDG to 10 in 2h'), null);
});

/* ------------------------------------------------------------ info commands */

test('wallet, with and without a subject', () => {
  assert.deepEqual(parseCommand('@Pourboireonsol wallet'), {
    kind: 'info',
    topic: 'wallet',
    subject: null,
  });
  assert.deepEqual(parseCommand('@Pourboireonsol wallet @Alice'), {
    kind: 'info',
    topic: 'wallet',
    subject: '@alice',
  });
});

test('address is a synonym for wallet', () => {
  const parsed = parseCommand('@Pourboireonsol address @bob');
  assert.equal(parsed?.kind, 'info');
  assert.equal((parsed as { topic: string }).topic, 'wallet');
});

test('stats and help', () => {
  assert.equal((parseCommand('@Pourboireonsol stats') as { topic: string })?.topic, 'stats');
  assert.equal((parseCommand('@Pourboireonsol received @a') as { topic: string })?.topic, 'stats');
  assert.equal((parseCommand('@Pourboireonsol help') as { topic: string })?.topic, 'help');
  assert.equal((parseCommand('@Pourboireonsol commands') as { topic: string })?.topic, 'help');
});

test('balance is deliberately not a command', () => {
  // Answering in-thread would publish someone's balance permanently.
  assert.equal(parseCommand('@Pourboireonsol balance'), null);
  assert.equal(parseCommand('@Pourboireonsol balance @alice'), null);
});

test('asking for the bot\u2019s own wallet resolves to no subject', () => {
  // Otherwise the reply hands out an address people might tip into by accident.
  const parsed = parseCommand('@Pourboireonsol wallet @Pourboireonsol');
  assert.equal((parsed as { subject: string | null })?.subject, null);
});

test('info verbs do not shadow tips', () => {
  // "tip" still wins even though these share the same prefix.
  assert.equal(parseCommand('@Pourboireonsol tip 0.5 USDG')?.kind, 'tip');
  assert.equal(parseCommand('@Pourboireonsol giveaway 5 USDG to 3 in 1h')?.kind, 'giveaway');
});

/* --------------------------------------------------------------- rain/match */

test('rain, with and without a recipient count', () => {
  assert.deepEqual(parseCommand('@Pourboireonsol rain 5 USDG'), {
    kind: 'rain',
    amount: '5',
    token: 'USDG',
    maxRecipients: RAIN_DEFAULT_RECIPIENTS,
  });
  assert.deepEqual(parseCommand('@Pourboireonsol rain 5 USDG to 20'), {
    kind: 'rain',
    amount: '5',
    token: 'USDG',
    maxRecipients: 20,
  });
  assert.deepEqual(parseCommand('@Pourboireonsol rain 2 USDG among 7 people'), {
    kind: 'rain',
    amount: '2',
    token: 'USDG',
    maxRecipients: 7,
  });
});

test('rain defaults to USDG and carries other tokens', () => {
  assert.equal((parseCommand('@Pourboireonsol rain 100') as { token: string })?.token, 'USDG');
  assert.equal(
    (parseCommand('@Pourboireonsol rain 1000000 NVDA to 5') as { token: string })?.token,
    'NVDA'
  );
});

test('rain strips thousands separators like every other amount', () => {
  assert.equal((parseCommand('@Pourboireonsol rain 1,500 NVDA') as { amount: string })?.amount, '1500');
});

test('match takes no arguments', () => {
  assert.deepEqual(parseCommand('@Pourboireonsol match'), { kind: 'match' });
  assert.deepEqual(parseCommand('@Pourboireonsol match!'), { kind: 'match' });
});

test('rain is not read as a giveaway or a tip', () => {
  // "rain 5 USDG to 20" ends in a bare number, which the tip patterns would
  // otherwise be happy to treat as part of the amount.
  assert.equal(parseCommand('@Pourboireonsol rain 5 USDG to 20')?.kind, 'rain');
  assert.equal(parseCommand('@Pourboireonsol giveaway 5 USDG to 20 in 1h')?.kind, 'giveaway');
  assert.equal(parseCommand('@Pourboireonsol tip 5 USDG @alice')?.kind, 'tip');
});

test('rain rejects a zero or absent amount', () => {
  assert.equal(parseCommand('@Pourboireonsol rain 0 USDG'), null);
  assert.equal(parseCommand('@Pourboireonsol rain'), null);
});

test('every command on the bot help card actually parses', () => {
  // The previous version of this test RETYPED the help card's lines in USDG
  // while the real card in info-commands.ts still said SOL — so it passed
  // against its own copy while five of the six live commands were ones the
  // parser refused. Reading HELP_COMMANDS directly is the point: there is now
  // one array, and a command that stops parsing fails the build.
  assert.ok(HELP_COMMANDS.length > 0, 'help card is empty');

  for (const { command } of HELP_COMMANDS) {
    assert.notEqual(
      parseCommand(`${BOT_HANDLE} ${command}`),
      null,
      `the help card teaches "${command}" but the parser refuses it`
    );
  }
});

test('the help card never teaches a retired symbol', () => {
  // A retired symbol parses to null, so the test above would already catch it —
  // but this says why, which is what someone reading a failure needs.
  for (const { command } of HELP_COMMANDS) {
    assert.equal(
      retiredSymbolIn(`${BOT_HANDLE} ${command}`),
      null,
      `the help card teaches a retired symbol: "${command}"`
    );
  }
});

test('every command the marketing copy teaches actually parses', () => {
  // The chain migration broke this once: the homepage still advertised
  // `tip 100000 BONK` after BONK stopped being a known symbol, so the single
  // most prominent example on the site was a command the bot would refuse.
  const taught = [
    exampleCommand(5),
    exampleRain(10),
    exampleGiveaway(),
    `${BOT_HANDLE} tip 1 NVDA`,
    `${BOT_HANDLE} split 30 USDG @a @b @c`,
    `${BOT_HANDLE} match`,
    `${BOT_HANDLE} wallet @alice`,
  ];

  for (const command of taught) {
    assert.notEqual(parseCommand(command), null, `taught but unparseable: ${command}`);
  }
});
