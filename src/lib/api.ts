/**
 * Shared route plumbing: one error shape, one place that decides what leaks.
 *
 * Routes used to each invent their own `{ error, details, stack, logs }` payload,
 * several of which returned raw exception text (and once, transaction logs) to
 * anonymous callers in production. Everything funnels through `fail`/`ok` now.
 */

import { NextResponse } from 'next/server';
import { AuthError } from './auth';
import { EnvError, isProduction } from './env';

export interface ApiErrorBody {
  /** Safe to show a user verbatim. */
  error: string;
  /** Machine-readable discriminator for the client. */
  code?: string;
}

export function ok<T extends object>(body: T, init?: ResponseInit) {
  return NextResponse.json({ success: true, ...body }, init);
}

export function fail(status: number, error: string, code?: string) {
  const body: ApiErrorBody = { error };
  if (code) body.code = code;
  return NextResponse.json(body, { status });
}

/**
 * Catch-all for route handlers. Known error types map to a useful message; every
 * other exception logs server-side and returns something generic, so internal
 * detail never reaches the caller in production.
 */
export function handleError(scope: string, e: unknown) {
  if (e instanceof AuthError) {
    return fail(e.status, e.message, 'unauthorized');
  }
  if (e instanceof EnvError) {
    console.error(`[${scope}] missing configuration: ${e.key}`);
    return fail(503, 'This feature is not configured yet. Try again later.', 'not_configured');
  }
  if (e instanceof ValidationError) {
    return fail(400, e.message, 'invalid_request');
  }
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[${scope}]`, message, e instanceof Error ? e.stack : '');
  return fail(
    500,
    isProduction() ? 'Something went wrong on our end. Please try again.' : message,
    'internal_error'
  );
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Assert-style helper so routes read as a list of preconditions. */
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ValidationError(message);
}

/**
 * Best-effort per-instance rate limiting.
 *
 * On serverless this is per warm instance, not global — it blunts casual abuse
 * and runaway client retry loops but is not a substitute for an edge limiter.
 * Deliberately in-process so it adds no latency to the hot path.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    // Opportunistic sweep so the map cannot grow without bound.
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
    }
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

export function tooManyRequests() {
  return fail(429, 'You are doing that too quickly. Give it a moment.', 'rate_limited');
}
