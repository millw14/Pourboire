'use client';

import type { ReactNode } from 'react';
import { PrivyProvider } from './privy-provider';
import { WalletProvider } from './wallet-provider';

/**
 * Single entry point for the wallet stack, so the dashboard layout can pull all
 * of it in with one dynamic import and one loading state.
 */
export function DashboardProviders({ children }: { children: ReactNode }) {
  return (
    <PrivyProvider>
      <WalletProvider>{children}</WalletProvider>
    </PrivyProvider>
  );
}
