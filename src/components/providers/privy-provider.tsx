'use client';

import { PrivyProvider as PrivyProviderBase } from '@privy-io/react-auth';
import type { FC, ReactNode } from 'react';
import { defineChain } from 'viem';
import { cluster, rpcUrl } from '@/lib/env';

/**
 * Privy, configured for Robinhood Chain.
 *
 * The chain is declared here rather than imported from `@/lib/chain`, which is
 * server-only — but both derive from the same `cluster()` value, so the browser
 * cannot end up on testnet while the server signs mainnet transfers. That
 * mismatch was a real bug in the previous version: the client was pinned to devnet
 * while the API defaulted to mainnet.
 */

const MAINNET = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
});

const TESTNET = defineChain({
  ...MAINNET,
  id: 46630,
  name: 'Robinhood Chain Testnet',
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
});

export const PrivyProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  if (!appId) {
    // Render the app anyway. Sign-in will not work, but the surrounding UI
    // stays usable and can say so — far better than a blank error screen.
    return <>{children}</>;
  }

  const base = cluster() === 'mainnet' ? MAINNET : TESTNET;
  const chain = defineChain({
    ...base,
    rpcUrls: { default: { http: [rpcUrl()] } },
  });

  return (
    <PrivyProviderBase
      appId={appId}
      config={{
        loginMethods: ['twitter', 'email', 'wallet'],
        embeddedWallets: {
          ethereum: { createOnLogin: 'users-without-wallets' },
        },
        appearance: {
          theme: 'dark',
          accentColor: '#00C805',
          logo: '/pour.png',
        },
        defaultChain: chain,
        supportedChains: [chain],
      }}
    >
      {children}
    </PrivyProviderBase>
  );
};
