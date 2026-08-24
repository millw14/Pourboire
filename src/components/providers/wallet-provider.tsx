'use client';

import { useMemo, type FC, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
// Imported from the individual packages rather than the `-wallets` barrel, which
// re-exports 36 adapters and drags every one of them into the bundle.
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import '@solana/wallet-adapter-react-ui/styles.css';
import { rpcUrl } from '@/lib/env';

/**
 * Mounted once, by the dashboard layout only.
 *
 * It was previously mounted in the root layout *and* again in the dashboard
 * layout, so /dashboard ran two ConnectionProviders and two autoConnecting
 * wallet trees against the same browser extension.
 */
export const WalletProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const endpoint = useMemo(() => rpcUrl(), []);
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
};
