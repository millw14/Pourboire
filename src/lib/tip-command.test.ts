import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommand,
  parseTipCommand,
  exampleCommand,
  exampleGiveaway,
  RAIN_DEFAULT_RECIPIENTS,
} from './tip-command.ts';

/**
 * The parser decides whether real money moves, so every case that used to be
 * silently dropped is pinned here.
 */

/* ------------------------------------------------------------------- tips */

test('parses the command the homepage teaches', () => {
  // This exact string was unparseable before: the tutorial said "@Pourboire"
  // while the regex demanded "@pourboireonsol" plus an explicit @recipient.
  assert.deepEqual(parseTipCommand('@Pourboire tip 0.5 SOL'), {
    kind: 'tip',
    amount: '0.5',
    token: 'SOL',
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
  const c = parseTipCommand('@Pourboireonsol tip 1.25 SOL @alice');
  assert.equal(c?.amount, '1.25');
  assert.equal(c?.recipientHandle, '@alice');
});

test('parses recipient before amount', () => {
  const c = parseTipCommand('@Pourboireonsol tip @bob 2 usdc');
  assert.equal(c?.amount, '2');
  assert.equal(c?.token, 'USDC');
  assert.equal(c?.recipientHandle, '@bob');
});

test('defaults to SOL when no token is given', () => {
  assert.equal(parseTipCommand('@Pourboireonsol tip 0.1 @carol')?.token, 'SOL');
});

test('is case insensitive and normalises handles', () => {
  assert.equal(parseTipCommand('@POURBOIREONSOL TIP 1 SOL @DaVe')?.recipientHandle, '@dave');
});

test('reads a command that appears mid-tweet', () => {
  assert.equal(parseTipCommand('great post! @Pourboireonsol tip 0.2 SOL')?.amount, '0.2');
});

test('refuses to tip the bot itself', () => {
  assert.equal(parseTipCommand('@Pourboireonsol tip 1 SOL @Pourboireonsol')?.recipientHandle, null);
});

test('rejects text that is not a command', () => {
  assert.equal(parseCommand('@Pourboireonsol what is this'), null);
  assert.equal(parseCommand('@Pourboireonsol tip me please'), null);
  assert.equal(parseCommand('just a normal tweet'), null);
});

test('rejects a zero amount', () => {
  assert.equal(parseCommand('@Pourboireonsol tip 0 SOL @alice'), null);
});

test('does not swallow a trailing word into the amount', () => {
  // "soldier" starts with "sol" - the negative lookahead must stop the
  // no-recipient pattern claiming it as a token.
  const c = parseTipCommand('@Pourboireonsol tip 0.5 soldier');
  assert.equal(c?.token, 'SOL');
  assert.equal(c?.amount, '0.5');
});

/* ----------------------------------------------------------- token support */

test('parses memecoin symbols', () => {
  const c = parseTipCommand('@Pourboireonsol tip 100000 BONK @alice');
  assert.equal(c?.token, 'BONK');
  assert.equal(c?.amount, '100000');
});

test('strips thousands separators from amounts', () => {
  assert.equal(parseTipCommand('@Pourboireonsol tip 1,000,000 BONK @alice')?.amount, '1000000');
});

test('accepts a raw mint address and preserves its casing', () => {
  // Base58 is case-sensitive: upper-casing a mint address breaks it.
  const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const c = parseTipCommand(`@Pourboireonsol tip 5 ${mint} @alice`);
  assert.equal(c?.token, mint);
});

/* ------------------------------------------------------ multiple recipients */

test('tips several people the same amount', () => {
  const c = parseTipCommand('@Pourboireonsol tip 1 SOL each @a @b @c');
  assert.equal(c?.mode, 'each');
  assert.deepEqual(c?.recipients, ['@a', '@b', '@c']);
});

test('splits one amount between several people', () => {
  const c = parseTipCommand('@Pourboireonsol split 3 SOL @a @b @c');
  assert.equal(c?.mode, 'split');
  assert.equal(c?.recipients.length, 3);
});

test('deduplicates repeated recipients', () => {
  const c = parseTipCommand('@Pourboireonsol tip 1 SOL each @a @a @b');
  assert.deepEqual(c?.recipients, ['@a', '@b']);
});

test('excludes the bot from a recipient list', () => {
  const c = parseTipCommand('@Pourboireonsol tip 1 SOL each @a @Pourboireonsol @b');
  assert.deepEqual(c?.recipients, ['@a', '@b']);
});

/* ------------------------------------------------------------- giveaways */

test('parses a giveaway with hours', () => {
  assert.deepEqual(parseCommand('@Pourboireonsol giveaway 5 SOL to 10 in 2h'), {
    kind: 'giveaway',
    amount: '5',
    token: 'SOL',
    winners: 10,
    durationMinutes: 120,
  });
});

test('parses a giveaway with the word "people" and minutes', () => {
  const g = parseCommand('@Pourboireonsol giveaway 1 SOL to 3 people in 30m');
  assert.equal(g?.kind, 'giveaway');
  assert.equal(g?.kind === 'giveaway' && g.durationMinutes, 30);
});

test('parses a giveaway in days', () => {
  const g = parseCommand('@Pourboireonsol giveaway 10 USDC to 5 winners in 1d');
  assert.equal(g?.kind === 'giveaway' && g.durationMinutes, 1440);
  assert.equal(g?.kind === 'giveaway' && g.token, 'USDC');
});

test('rejects giveaway windows that are too short or too long', () => {
  assert.equal(parseCommand('@Pourboireonsol giveaway 5 SOL to 10 in 1m'), null);
  assert.equal(parseCommand('@Pourboireonsol giveaway 5 SOL to 10 in 30d'), null);
});

test('rejects an absurd winner count', () => {
  assert.equal(parseCommand('@Pourboireonsol giveaway 5 SOL to 0 in 2h'), null);
  assert.equal(parseCommand('@Pourboireonsol giveaway 5 SOL to 500 in 2h'), null);
});

test('a giveaway is not read as a tip', () => {
  assert.equal(parseTipCommand('@Pourboireonsol giveaway 5 SOL to 10 in 2h'), null);
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
  assert.equal(parseCommand('@Pourboireonsol tip 0.5 SOL')?.kind, 'tip');
  assert.equal(parseCommand('@Pourboireonsol giveaway 5 SOL to 3 in 1h')?.kind, 'giveaway');
});

/* --------------------------------------------------------------- rain/match */

test('rain, with and without a recipient count', () => {
  assert.deepEqual(parseCommand('@Pourboireonsol rain 5 SOL'), {
    kind: 'rain',
    amount: '5',
    token: 'SOL',
    maxRecipients: RAIN_DEFAULT_RECIPIENTS,
  });
  assert.deepEqual(parseCommand('@Pourboireonsol rain 5 SOL to 20'), {
    kind: 'rain',
    amount: '5',
    token: 'SOL',
    maxRecipients: 20,
  });
  assert.deepEqual(parseCommand('@Pourboireonsol rain 2 SOL among 7 people'), {
    kind: 'rain',
    amount: '2',
    token: 'SOL',
    maxRecipients: 7,
  });
});

test('rain defaults to SOL and carries other tokens', () => {
  assert.equal((parseCommand('@Pourboireonsol rain 100') as { token: string })?.token, 'SOL');
  assert.equal(
    (parseCommand('@Pourboireonsol rain 1000000 BONK to 5') as { token: string })?.token,
    'BONK'
  );
});

test('rain strips thousands separators like every other amount', () => {
  assert.equal((parseCommand('@Pourboireonsol rain 1,500 BONK') as { amount: string })?.amount, '1500');
});

test('match takes no arguments', () => {
  assert.deepEqual(parseCommand('@Pourboireonsol match'), { kind: 'match' });
  assert.deepEqual(parseCommand('@Pourboireonsol match!'), { kind: 'match' });
});

test('rain is not read as a giveaway or a tip', () => {
  // "rain 5 SOL to 20" ends in a bare number, which the tip patterns would
  // otherwise be happy to treat as part of the amount.
  assert.equal(parseCommand('@Pourboireonsol rain 5 SOL to 20')?.kind, 'rain');
  assert.equal(parseCommand('@Pourboireonsol giveaway 5 SOL to 20 in 1h')?.kind, 'giveaway');
  assert.equal(parseCommand('@Pourboireonsol tip 5 SOL @alice')?.kind, 'tip');
});

test('rain rejects a zero or absent amount', () => {
  assert.equal(parseCommand('@Pourboireonsol rain 0 SOL'), null);
  assert.equal(parseCommand('@Pourboireonsol rain'), null);
});
