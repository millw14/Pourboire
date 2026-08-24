import type { NextConfig } from 'next';

/**
 * The config was the empty scaffold. It now does three jobs.
 */
const nextConfig: NextConfig = {
  /**
   * 1. Keep libsodium out of the bundler.
   *
   * `libsodium-wrappers`' ESM entry does a bare relative import of
   * `./libsodium.mjs`, which only resolves through the sibling `libsodium`
   * package at runtime — Turbopack cannot follow it and the build fails. Node
   * resolves it fine, so it is loaded natively on the server instead.
   *
   * It is deliberately still libsodium and not, say, node:crypto AES-GCM:
   * every custodial key already in the database is a secretbox ciphertext, and
   * changing the algorithm would make all of them undecryptable.
   */
  serverExternalPackages: ['libsodium-wrappers'],

  /**
   * 2. Security headers. There were none.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // The app is never legitimately framed; this blocks clickjacking of
          // the withdraw and fund flows.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
      {
        // API responses are per-user and must never be held by a shared cache.
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
      },
    ];
  },

  /**
   * 3. Fail the build on type errors rather than shipping them. This is the
   * default; stated explicitly so nobody "fixes" a red build by turning it off.
   * Lint runs separately via `npm run check` — Next 16 no longer accepts an
   * `eslint` key here.
   */
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
