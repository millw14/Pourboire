import 'server-only';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { parseSponsorKey } from './key.ts';

/**
 * The only module in the application that touches the sponsor key.
 *
 * It exports an address and a signer, never the key itself, so a grep for
 * `SPONSOR_PRIVATE_KEY` returns exactly one file and there is no way for the key
 * to reach a log line, an error, or a route by accident. A test asserts that.
 *
 * The sponsor key is deliberately a different *shape* from a user key as well as
 * a different location: custodial keys live in Mongo as libsodium secretbox
 * ciphertext and are decoded by `crypto.ts`, while this one is raw hex from the
 * environment and never goes near that path. A refactor that confuses the two
 * fails loudly rather than quietly signing with the wrong wallet.
 */

let cached: { account: ReturnType<typeof privateKeyToAccount> } | null = null;
let resolved = false;

function load() {
  if (resolved) return cached;
  resolved = true;

  const parsed = parseSponsorKey(process.env.SPONSOR_PRIVATE_KEY);
  if (!parsed.ok) {
    if (parsed.reason === 'malformed') {
      // Loud, because an absent key is a choice and a malformed one is a
      // mistake. The detail never quotes the value.
      console.error(`[gas] SPONSOR_PRIVATE_KEY is malformed: ${parsed.detail}. Sponsorship is off.`);
    }
    cached = null;
    return null;
  }

  cached = { account: privateKeyToAccount(parsed.key) };
  return cached;
}

/** Is sponsorship available in this deployment at all? */
export function sponsorConfigured(): boolean {
  return load() !== null;
}

/** The sponsor's own address, for reading its balance. Null when unconfigured. */
export function sponsorAddress(): Address | null {
  return load()?.account.address ?? null;
}

/**
 * Run something with the sponsor key.
 *
 * A callback rather than a getter, so the key is never a value a caller holds
 * onto, stores, or accidentally returns. Everything that signs as the sponsor
 * goes through here.
 */
export function withSponsorKey<T>(fn: (key: `0x${string}`) => T): T | null {
  const parsed = parseSponsorKey(process.env.SPONSOR_PRIVATE_KEY);
  if (!parsed.ok) return null;
  return fn(parsed.key);
}
