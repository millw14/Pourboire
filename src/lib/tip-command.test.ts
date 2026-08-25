import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommand,
  parseTipCommand,
  exampleCommand,
  exampleGiveaway,
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
