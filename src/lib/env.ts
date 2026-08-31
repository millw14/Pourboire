/**
 * Centralised, lazily-validated environment access.
 *
 * Nothing in here throws at module scope. Importing a module must never crash the
 * build just because a secret is absent — that is what broke `next build` on a
 * clean checkout. Each accessor validates on first *use* instead, so a missing
 * secret produces a clear 500 on the one route that needs it rather than an
 * opaque build failure across the whole app.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new EnvError(name);
  }
  return value;
}

export class EnvError extends Error {
  // Assigned in the body rather than as a constructor parameter property:
  // Node's type-stripping (which the test runner uses) rejects that syntax, and
  // this module is reachable from modules under test.
  readonly key: string;

  constructor(key: string) {
    super(`Missing required environment variable: ${key}`);
    this.name = 'EnvError';
    this.key = key;
  }
}

/** Mongo connection string. Required by every route that touches the database. */
export const mongoUri = () => required('MONGODB_URI');

/** 32-byte hex key used for libsodium secretbox around custodial private keys. */
export const encryptionKey = () => required('ENCRYPTION_KEY');

export const privyAppId = () => required('NEXT_PUBLIC_PRIVY_APP_ID');
export const privyAppSecret = () => required('PRIVY_APP_SECRET');

export const twitterCredentials = () => ({
  appKey: required('TWITTER_API_KEY'),
  appSecret: required('TWITTER_API_SECRET'),
  accessToken: required('TWITTER_ACCESS_TOKEN'),
  accessSecret: required('TWITTER_ACCESS_SECRET'),
});

/**
 * Which Robinhood Chain network this deployment operates on. Everything — the
 * wallet config, the server RPC, the explorer links — derives from this single
 * value, so the browser can never think it is on testnet while the server signs
 * mainnet transfers.
 */
export type Cluster = 'mainnet' | 'testnet';

export function cluster(): Cluster {
  // Defaults to testnet: a misconfigured deployment should move play money, not
  // real money.
  const raw = (process.env.NEXT_PUBLIC_CHAIN_NETWORK || 'testnet').toLowerCase();
  return raw.includes('main') ? 'mainnet' : 'testnet';
}

export function rpcUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_CHAIN_RPC_URL;
  if (explicit) return explicit;
  return cluster() === 'mainnet'
    ? 'https://rpc.mainnet.chain.robinhood.com'
    : 'https://rpc.testnet.chain.robinhood.com';
}

export const isProduction = () => process.env.NODE_ENV === 'production';

/** Public origin, used to build absolute URLs for receipt cards and profiles. */
export function baseUrl(): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}
