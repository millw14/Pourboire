import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsLink } from './twitter.ts';

/**
 * X charges $0.20 for a post containing a URL against $0.015 for a plain one.
 * On a 0.01 SOL tip that is 22% of the tip's value versus 4%, so a stray domain
 * in a message template is a real cost regression. These cases pin the detector
 * that catches it.
 */

test('catches full URLs', () => {
  assert.ok(containsLink('paid: https://solscan.io/tx/abc'));
  assert.ok(containsLink('see http://example.com'));
});

test('catches bare domains, which X auto-links too', () => {
  // This is the one that actually bit: no scheme, still billed as a link.
  assert.ok(containsLink('sign in at pourboire.tips to use it'));
  assert.ok(containsLink('verify at solscan.io'));
});

test('does not trip on decimal amounts', () => {
  assert.ok(!containsLink('@alice sent you 0.5 SOL'));
  assert.ok(!containsLink('1.25 SOL and 100,000.5 BONK'));
});

test('does not trip on ordinary punctuation', () => {
  assert.ok(!containsLink('Nothing was sent. Try again.'));
  assert.ok(!containsLink('@bob @alice sent you 2 SOL. It is in your tip wallet.'));
});

test('does not trip on handles or hashtags', () => {
  assert.ok(!containsLink('@Pourboireonsol tip 0.5 SOL @alice'));
});

test('every canned bot reply is link-free', () => {
  // The actual strings the bot sends. If someone adds a URL to one of these,
  // this test is what tells them what it costs.
  const replies = [
    "@alice I don't recognise that token, so nothing was sent.",
    '@alice that amount is too small. Nothing was sent.',
    '@bob @alice wants to tip you 0.5 SOL. They need to sign in and fund their tip wallet first.',
    '@bob @alice sent you 0.5 SOL. It is already in your tip wallet — receipt below.',
    "@alice your tip wallet doesn't have enough SOL for that tip. Top it up and mention me again.",
    '@alice USDC tips are not supported yet — only SOL for now. Nothing was sent.',
    '@alice nobody entered, so nothing was paid out.',
  ];
  for (const reply of replies) {
    assert.ok(!containsLink(reply), `would be billed as a link: ${reply}`);
  }
});
