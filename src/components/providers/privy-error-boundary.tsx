'use client';

import Link from 'next/link';
import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Scoped to the dashboard.
 *
 * When this wrapped the whole app in the root layout, a Privy initialisation
 * failure replaced every page — including the public landing page — with a bare
 * "Authentication Error" screen. Sign-in breaking should cost you sign-in, not
 * the website.
 */

interface State {
  hasError: boolean;
}

export class PrivyErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[dashboard] render error', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <main className="flex min-h-screen items-center justify-center bg-black px-6 text-white">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-extralight tracking-tight">Sign-in is unavailable</h1>
          <p className="mt-3 text-sm font-light leading-relaxed text-white/70">
            We could not start the authentication service. Your funds are not affected — this
            is a problem loading the page, not with your wallet.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-xl bg-white/10 px-4 py-2 text-sm font-light transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              Try again
            </button>
            <Link
              href="/"
              className="rounded-xl border border-white/15 px-4 py-2 text-sm font-light transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              Back to home
            </Link>
          </div>
        </div>
      </main>
    );
  }
}
