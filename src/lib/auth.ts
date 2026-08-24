/**
 * Server-side identity.
 *
 * Previously every money-moving route took a `handle` straight out of the request
 * body and trusted it. That meant anyone could POST someone else's handle and act
 * as them. Identity now comes from a Privy access token that we verify against
 * Privy's servers; the handle in the body is ignored entirely.
 */

import { PrivyClient } from '@privy-io/server-auth';
import type { NextRequest } from 'next/server';
import { privyAppId, privyAppSecret } from './env';

let cachedClient: PrivyClient | null = null;

function client(): PrivyClient {
  if (!cachedClient) {
    cachedClient = new PrivyClient(privyAppId(), privyAppSecret());
  }
  return cachedClient;
}

export interface Caller {
  /** Privy's own user id (`did:privy:...`). Stable across handle changes. */
  privyUserId: string;
  /** X/Twitter numeric id, when the user linked an X account. */
  twitterId?: string;
  /** Normalised `@handle`, when the user linked an X account. */
  handle?: string;
  name?: string;
  profileImage?: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403 = 401
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** `@Foo` and `foo` both normalise to `@foo`, so lookups stop needing three attempts. */
export function normalizeHandle(handle: string): string {
  const trimmed = handle.trim().replace(/^@+/, '');
  return `@${trimmed.toLowerCase()}`;
}

function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() || null;
  }
  // Privy also sets a cookie; fall back to it so same-origin fetches work
  // without the caller having to plumb the token through by hand.
  return req.cookies.get('privy-token')?.value ?? null;
}

/**
 * Resolve the authenticated caller, or throw AuthError.
 * Use this at the top of every route that reads or moves a user's money.
 */
export async function requireCaller(req: NextRequest): Promise<Caller> {
  const token = bearerToken(req);
  if (!token) {
    throw new AuthError('Sign in to continue');
  }

  let privyUserId: string;
  try {
    const claims = await client().verifyAuthToken(token);
    privyUserId = claims.userId;
  } catch {
    throw new AuthError('Your session has expired. Sign in again.');
  }

  let user;
  try {
    user = await client().getUser(privyUserId);
  } catch {
    throw new AuthError('Could not load your account. Sign in again.');
  }

  const twitter = user.twitter;
  return {
    privyUserId,
    twitterId: twitter?.subject,
    handle: twitter?.username ? normalizeHandle(twitter.username) : undefined,
    name: twitter?.name ?? undefined,
    profileImage: twitter?.profilePictureUrl ?? undefined,
  };
}

/**
 * Guard for machine-triggered endpoints (the mention poller). Accepts either a
 * `CRON_SECRET` bearer token or Vercel Cron's signed header. If CRON_SECRET is
 * not configured the endpoint stays closed — failing shut, not open.
 */
export function requireMachineCaller(req: NextRequest): void {
  const configured = process.env.CRON_SECRET;
  if (!configured) {
    throw new AuthError('This endpoint is disabled until CRON_SECRET is configured', 403);
  }
  const header = req.headers.get('authorization');
  const presented = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
  if (presented && timingSafeEqual(presented, configured)) return;
  throw new AuthError('Not authorised', 403);
}

/** Constant-time compare so the secret can't be recovered by timing the response. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
