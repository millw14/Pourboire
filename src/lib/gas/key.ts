/**
 * Validating the sponsor key's shape, separately from using it.
 *
 * Pure on purpose. The module that actually signs is `server-only` and cannot be
 * loaded by the test runner, so without this the only thing standing between a
 * mistyped environment variable and a confusing runtime failure would be a
 * comment.
 *
 * It deliberately does not accept the same shapes a user key might arrive in.
 * Custodial keys live in Mongo as libsodium secretbox ciphertext and are decoded
 * by `crypto.ts`; the sponsor key is a raw hex string from the environment and
 * never touches that path. Keeping the two formats distinct means a future
 * refactor that confuses them fails loudly rather than quietly signing with the
 * wrong wallet.
 */

export type SponsorKeyResult =
  /** No key configured. Sponsorship is simply switched off for this deployment. */
  | { ok: false; reason: 'absent' }
  | { ok: false; reason: 'malformed'; detail: string }
  | { ok: true; key: `0x${string}` };

const HEX_KEY = /^0x[0-9a-f]{64}$/;

export function parseSponsorKey(raw: string | undefined | null): SponsorKeyResult {
  if (raw === undefined || raw === null) return { ok: false, reason: 'absent' };

  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'absent' };

  // Lowercased before matching so a key pasted from a checksummed source is not
  // rejected for its casing alone.
  const normalised = trimmed.toLowerCase();

  if (!normalised.startsWith('0x')) {
    return { ok: false, reason: 'malformed', detail: 'must start with 0x' };
  }
  if (normalised.length !== 66) {
    return {
      ok: false,
      reason: 'malformed',
      // Deliberately reports the length and nothing else. A private key must
      // never appear in an error, a log line, or a stack trace.
      detail: `must be 66 characters, got ${normalised.length}`,
    };
  }
  if (!HEX_KEY.test(normalised)) {
    return { ok: false, reason: 'malformed', detail: 'must be hexadecimal' };
  }

  // All-zero is a valid 32-byte string and not a valid secp256k1 key. It is also
  // exactly what a half-finished config file contains.
  if (/^0x0+$/.test(normalised)) {
    return { ok: false, reason: 'malformed', detail: 'is all zeroes' };
  }

  return { ok: true, key: normalised as `0x${string}` };
}

/** Is sponsorship configured at all? Drives the policy's `configured` flag. */
export function sponsorConfigured(raw: string | undefined | null): boolean {
  return parseSponsorKey(raw).ok;
}
