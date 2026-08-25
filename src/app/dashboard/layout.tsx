'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { PrivyErrorBoundary } from '@/components/providers/privy-error-boundary';
import { ToastProvider } from '@/components/ui/toast';

/**
 * The wallet stack is scoped to this subtree and loaded client-side only.
 *
 * `ssr: false` is what lets the provider mount once, in its final position,
 * instead of the old pattern where an `isClient` flag swapped the component type
 * after hydration and remounted the whole tree underneath it.
 *
 * The stylesheet the old layout pulled from `unpkg.com/...@latest` is gone: it
 * duplicated CSS the wallet-adapter package already ships (which
 * wallet-provider.tsx imports), blocked render on a third-party host, and pinned
 * nothing — whatever unpkg served as "latest" ran on the page.
 */

const Providers = dynamic(
  () =>
    import('@/components/providers/dashboard-providers').then((m) => m.DashboardProviders),
  {
    ssr: false,
    loading: () => <DashboardSkeleton />,
  }
);

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <PrivyErrorBoundary>
      <ToastProvider>
        <Providers>{children}</Providers>
      </ToastProvider>
    </PrivyErrorBoundary>
  );
}

/**
 * Shown while the wallet stack loads. It mirrors the real dashboard's layout so
 * the page does not jump when the content arrives.
 */
function DashboardSkeleton() {
  return (
    <div className="min-h-screen bg-black text-white">
      <div className="border-b border-white/10 bg-white/5">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="h-7 w-48 animate-pulse rounded bg-white/10" />
          <div className="h-9 w-32 animate-pulse rounded-xl bg-white/10" />
        </div>
      </div>
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
        <div className="h-32 animate-pulse rounded-2xl bg-white/5" />
        <div className="h-40 animate-pulse rounded-2xl bg-white/5" />
        <div className="h-12 animate-pulse rounded-xl bg-white/5" />
      </div>
      <span className="sr-only" role="status">
        Loading your dashboard
      </span>
    </div>
  );
}
