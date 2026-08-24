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
  constructor(public readonly key: string) {
    super(`Missing required environment variable: ${key}`);
    this.name = 'EnvError';
  }
}

/** Mongo connection string. Required by every route that touches the database. */
export const mongoUri = () => required('MONGODB_URI');

/** 32-byte hex key used for libsodium secretbox around custodial private keys. */
export const encryptionKey = () => required('ENCRYPTION_KEY');

export const privyAppId = () => required('NEXT_PUBLIC_PRIVY_APP_ID');
export const privyAppSecret = () => required('PRIVY_APP_SECRET');

/**
 * Shared secret for machine-triggered endpoints (the mention poller). Without it
 * set, those endpoints refuse to run at all rather than defaulting to open.
 */
export const cronSecret = () => required('CRON_SECRET');

export const twitterCredentials = () => ({
  appKey: required('TWITTER_API_KEY'),
  appSecret: required('TWITTER_API_SECRET'),
  accessToken: required('TWITTER_ACCESS_TOKEN'),
  accessSecret: required('TWITTER_ACCESS_SECRET'),
});

/**
 * Which Solana cluster this deployment operates on. Everything — the client
 * wallet adapter, the server RPC, the explorer links — derives from this single
 * value so the browser can never think it is on devnet while the server signs
 * mainnet transfers.
 */
export type Cluster = 'mainnet-beta' | 'devnet' | 'testnet';

export function cluster(): Cluster {
  const raw = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER || 'devnet').toLowerCase();
  if (raw.includes('main')) return 'mainnet-beta';
  if (raw.includes('test')) return 'testnet';
  return 'devnet';
}

export function rpcUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  if (explicit) return explicit;
  switch (cluster()) {
    case 'mainnet-beta':
      return 'https://api.mainnet-beta.solana.com';
    case 'testnet':
      return 'https://api.testnet.solana.com';
    default:
      return 'https://api.devnet.solana.com';
  }
}

export const isProduction = () => process.env.NODE_ENV === 'production';

/** Public origin, used when one route needs to call another. */
export function baseUrl(): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

/**
 * Report which variables are configured, for the startup/health check.
 * Never returns a value — only whether it is present.
 */
export function envReport() {
  const keys = [
    'MONGODB_URI',
    'ENCRYPTION_KEY',
    'NEXT_PUBLIC_PRIVY_APP_ID',
    'PRIVY_APP_SECRET',
    'CRON_SECRET',
    'TWITTER_API_KEY',
    'TWITTER_API_SECRET',
    'TWITTER_ACCESS_TOKEN',
    'TWITTER_ACCESS_SECRET',
    'NEXT_PUBLIC_SOLANA_RPC_URL',
    'NEXT_PUBLIC_SOLANA_CLUSTER',
  ] as const;
  return {
    cluster: cluster(),
    configured: Object.fromEntries(keys.map((k) => [k, Boolean(process.env[k])])),
  };
}
