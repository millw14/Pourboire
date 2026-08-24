'use client';

import { useCallback } from 'react';
import { getAccessToken } from '@privy-io/react-auth';

/**
 * Authenticated fetch for the dashboard.
 *
 * Requests used to identify the user by putting their handle in the body, which
 * is why anyone could act as anyone. Every call now carries a Privy access token
 * that the server verifies; the body never names an account.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function useApi() {
  return useCallback(async <T>(path: string, init?: RequestInit): Promise<T> => {
    const token = await getAccessToken();
    if (!token) {
      throw new ApiError('Your session has expired. Sign in again.', 401, 'unauthorized');
    }

    let res: Response;
    try {
      res = await fetch(path, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(init?.headers ?? {}),
          Authorization: `Bearer ${token}`,
        },
      });
    } catch {
      // A network failure is the one case where the user genuinely can retry, so
      // it gets its own message rather than the generic server one.
      throw new ApiError("Couldn't reach the server. Check your connection.", 0, 'network');
    }

    const body = await res.json().catch(() => null);

    if (!res.ok) {
      throw new ApiError(
        body?.error ?? 'Something went wrong. Please try again.',
        res.status,
        body?.code
      );
    }
    return body as T;
  }, []);
}
