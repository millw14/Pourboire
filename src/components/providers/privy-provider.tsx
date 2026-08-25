'use client';

import { PrivyProvider as PrivyProviderBase } from '@privy-io/react-auth';
import type { FC, ReactNode } from 'react';
import { cluster } from '@/lib/env';

/**
 * Privy, configured for the cluster this deployment actually runs on.
 *
 * Two problems are fixed here:
 *
 *  1. The chain config was hardcoded to Solana **devnet** while the API routes
 *     defaulted to **mainnet-beta**. A user could approve a transaction that the
 *     UI described as devnet while real money moved.
 *
 *  2. The old `isClient` gate rendered `<>{children}</>` on the server and first
 *     client render, then swapped in `<PrivyProviderBase>` after mount. Because
 *     React reconciles that position by type, the entire app below it unmounted
 *     and remounted on every load — throwing away all component state and
 *     re-running every effect. `ssr: false` on the dynamic import handles this
 *     properly instead.
 */

const CHAINS = {
  'mainnet-beta': {
    id: 101,
    name: 'Solana',
    network: 'mainnet-beta',
    rpc: 'https://api.mainnet-beta.solana.com',
  },
  devnet: {
    id: 103,
    name: 'Solana Devnet',
    network: 'devnet',
    rpc: 'https://api.devnet.solana.com',
  },
  testnet: {
    id: 102,
    name: 'Solana Testnet',
    network: 'testnet',
    rpc: 'https://api.testnet.solana.com',
  },
} as const;

export const PrivyProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) {
    // Render the app anyway. Sign-in will not work, but the surrounding UI
    // stays usable and can say so — far better than a blank error screen.
    return <>{children}</>;
  }

  const active = CHAINS[cluster()];
  const rpc = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || active.rpc;

  return (
    <PrivyProviderBase
      appId={appId}
      config={{
        loginMethods: ['twitter', 'email', 'wallet'],
        embeddedWallets: {
          solana: { createOnLogin: 'users-without-wallets' },
        },
        appearance: {
          theme: 'dark',
          accentColor: '#3B82F6',
          logo: '/pour.png',
        },
        supportedChains: [
          {
            id: active.id,
            name: active.name,
            network: active.network,
            nativeCurrency: { name: 'SOL', symbol: 'SOL', decimals: 9 },
            rpcUrls: { default: { http: [rpc] }, public: { http: [rpc] } },
          },
        ],
      }}
    >
      {children}
    </PrivyProviderBase>
  );
};
