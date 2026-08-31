'use client';

import type { ReactNode } from 'react';
import { PrivyProvider } from './privy-provider';

/**
 * The dashboard's client-side provider stack.
 *
 * Now just Privy: it handles EVM wallets natively, so the separate Solana
 * wallet-adapter tree — a second ConnectionProvider, its own modal, and 36
 * bundled adapters — is gone entirely.
 */
export function DashboardProviders({ children }: { children: ReactNode }) {
  return <PrivyProvider>{children}</PrivyProvider>;
}
