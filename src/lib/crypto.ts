import 'server-only';
import { createRequire } from 'node:module';
import type sodiumType from 'libsodium-wrappers';
import { encryptionKey } from './env';

/**
 * Loaded through `require`, not `import`.
 *
 * libsodium-wrappers' ESM entry (`dist/modules-esm/libsodium-wrappers.mjs`)
 * starts with `import e from "./libsodium.mjs"` — a file the package does not
 * ship. Only the CJS build resolves, so we ask for it explicitly rather than
 * letting the `exports` map hand us the broken ESM one. Paired with
 * `serverExternalPackages: ['libsodium-wrappers']` in next.config.ts.
 */
const sodium: typeof sodiumType = createRequire(import.meta.url)('libsodium-wrappers');

/**
 * XSalsa20-Poly1305 (libsodium secretbox) around custodial wallet secret keys.
 *
 * Two things changed from the original:
 *
 *  1. `await sodium.ready` was a top-level await, which made every importer an
 *     async module and dragged the whole route into a slower load path. It is now
 *     awaited on first use.
 *
 *  2. The key was `parseInt`'d without validation. `parseInt('zz', 16)` is NaN,
 *     which becomes 0 in a Uint8Array — so a typo'd or short ENCRYPTION_KEY
 *     silently produced a partly- or entirely-zero key and encrypted every
 *     private key under it. That now throws.
 */

const KEY_BYTES = 32; // crypto_secretbox_KEYBYTES

let ready: Promise<void> | null = null;
async function init(): Promise<void> {
  if (!ready) ready = sodium.ready;
  await ready;
}

function hexToUint8Array(hex: string, label: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`${label} is not valid hex`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function loadKey(): Uint8Array {
  const key = hexToUint8Array(encryptionKey(), 'ENCRYPTION_KEY');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex characters), got ${key.length}`
    );
  }
  return key;
}

export async function encryptPrivateKey(privateKey: Uint8Array): Promise<string> {
  await init();
  const key = loadKey();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const encrypted = sodium.crypto_secretbox_easy(privateKey, nonce, key);

  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);
  return uint8ArrayToHex(combined);
}

export async function decryptPrivateKey(encryptedHex: string): Promise<Uint8Array> {
  await init();
  const key = loadKey();
  const combined = hexToUint8Array(encryptedHex, 'encrypted key');

  if (combined.length <= sodium.crypto_secretbox_NONCEBYTES) {
    throw new Error('Stored key is truncated');
  }

  const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const encrypted = combined.slice(sodium.crypto_secretbox_NONCEBYTES);

  // Throws on authentication failure rather than returning a falsy value.
  const decrypted = sodium.crypto_secretbox_open_easy(encrypted, nonce, key);
  if (!decrypted) throw new Error('Failed to decrypt private key');
  return decrypted;
}

export async function generateEncryptionKey(): Promise<string> {
  await init();
  return uint8ArrayToHex(sodium.randombytes_buf(KEY_BYTES));
}
