import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTipCommand, exampleCommand } from './tip-command.ts';

/**
 * The parser decides whether real money moves, so the cases that used to be
 * silently dropped are pinned here.
 */

test('parses the command the homepage teaches', () => {
  // This exact string was unparseable before: the tutorial said "@Pourboire"
  // while the regex demanded "@pourboireonsol" plus an explicit @recipient.
  const parsed = parseTipCommand('@Pourboire tip 0.5 SOL');
  assert.deepEqual(parsed, { amount: 0.5, token: 'SOL', recipientHandle: null });
});

test('the documented example is parseable', () => {
  assert.notEqual(parseTipCommand(exampleCommand(0.5)), null);
});

test('parses amount, token, then recipient', () => {
  assert.deepEqual(parseTipCommand('@Pourboireonsol tip 1.25 SOL @alice'), {
    amount: 1.25,
    token: 'SOL',
    recipientHandle: '@alice',
  });
});

test('parses recipient before amount', () => {
  assert.deepEqual(parseTipCommand('@Pourboireonsol tip @bob 2 usdc'), {
    amount: 2,
    token: 'USDC',
    recipientHandle: '@bob',
  });
});

test('defaults to SOL when no token is given', () => {
  assert.equal(parseTipCommand('@Pourboireonsol tip 0.1 @carol')?.token, 'SOL');
});

test('is case insensitive and normalises the recipient', () => {
  assert.equal(parseTipCommand('@POURBOIREONSOL TIP 1 SOL @DaVe')?.recipientHandle, '@dave');
});

test('reads a command that appears mid-tweet', () => {
  assert.equal(parseTipCommand('great post! @Pourboireonsol tip 0.2 SOL')?.amount, 0.2);
});

test('refuses to tip the bot itself', () => {
  // Falls through to the no-recipient form rather than paying the bot.
  assert.equal(parseTipCommand('@Pourboireonsol tip 1 SOL @Pourboireonsol')?.recipientHandle, null);
});

test('rejects text that is not a tip', () => {
  assert.equal(parseTipCommand('@Pourboireonsol what is this'), null);
  assert.equal(parseTipCommand('@Pourboireonsol tip me please'), null);
  assert.equal(parseTipCommand('just a normal tweet'), null);
});

test('rejects a zero amount', () => {
  assert.equal(parseTipCommand('@Pourboireonsol tip 0 SOL @alice'), null);
});

test('does not swallow a trailing word into the amount', () => {
  const parsed = parseTipCommand('@Pourboireonsol tip 0.5 soldier');
  // "soldier" starts with "sol" - the negative lookahead must stop the
  // no-recipient pattern claiming it as a token.
  assert.equal(parsed?.token, 'SOL');
  assert.equal(parsed?.amount, 0.5);
});
