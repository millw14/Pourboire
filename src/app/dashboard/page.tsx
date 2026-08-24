'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePrivy } from '@privy-io/react-auth';
import { useApi, ApiError } from '@/lib/use-api';
import { useToast } from '@/components/ui/toast';
import { CopyButton, truncateMiddle } from '@/components/ui/copy-button';
import { exampleCommand } from '@/lib/tip-command';
import { FundDialog } from './fund-dialog';
import { WithdrawDialog } from './withdraw-dialog';
import type { MeResponse, HistoryItem } from './types';

type Tab = 'overview' | 'activity';

export default function DashboardPage() {
  // `ready` is the fix for the logged-out flash: usePrivy reports user=null while
  // it restores the session, and the old code rendered the whole "Connect your
  // account" screen during that window on every single load.
  const { ready, authenticated, user, login, logout } = usePrivy();
  const api = useApi();
  const { toast } = useToast();

  const [data, setData] = useState<MeResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Derived, not stored: "loading" is simply "signed in, nothing yet, no error".
  // Keeping it in state meant setting it synchronously from an effect, and left
  // room for the flag and the data to disagree.
  const loadState: 'idle' | 'loading' | 'loaded' | 'error' = !authenticated
    ? 'idle'
    : data
      ? 'loaded'
      : loadError
        ? 'error'
        : 'loading';
  const [tab, setTab] = useState<Tab>('overview');
  const [fundOpen, setFundOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  // Bumped to ask the effect below for a fresh load.
  const [reloadKey, setReloadKey] = useState(0);

  // The initial load is owned by the effect, with a cancellation guard so a slow
  // response from a previous session cannot land on top of a newer one.
  useEffect(() => {
    if (!ready || !authenticated) return;
    let cancelled = false;

    void (async () => {
      try {
        const res = await api<MeResponse>('/api/me');
        if (cancelled) return;
        setData(res);
        setLoadError(null);
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof ApiError ? e.message : 'Could not load your dashboard.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, api, reloadKey]);

  /**
   * Background refresh, called from event handlers after an action changes the
   * balance. A failure here surfaces as a toast and leaves the dashboard showing
   * the data it already has, rather than blanking a working screen.
   */
  const refresh = useCallback(async () => {
    try {
      const res = await api<MeResponse>('/api/me');
      setData(res);
      setLoadError(null);
    } catch (e) {
      toast({
        tone: 'error',
        title: "Couldn't refresh",
        description: e instanceof ApiError ? e.message : 'Please try again.',
      });
    }
  }, [api, toast]);

  const wallet = data?.wallet ?? null;
  const balanceLabel = useMemo(() => {
    if (!wallet) return null;
    if (wallet.balanceError || wallet.balanceSol === null) return null;
    return wallet.balanceSol.toFixed(4);
  }, [wallet]);

  if (!ready) return <FullScreenStatus message="Restoring your session…" />;

  return (
    <div className="min-h-screen bg-black text-white">
      <BackgroundGlow />

      <header className="relative z-10 border-b border-white/10 bg-white/5 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
            <Link
              href="/"
              className="truncate text-xl font-extralight tracking-tight sm:text-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 rounded"
            >
              Pourboire
            </Link>
            {data?.cluster && data.cluster !== 'mainnet-beta' && (
              // A visible, permanent reminder. The old UI showed a green "Live"
              // badge regardless of which cluster it was pointed at.
              <span className="rounded-full bg-amber-500/20 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-amber-300">
                {data.cluster}
              </span>
            )}
            {data?.user?.handle && (
              <span className="truncate rounded-full bg-blue-500/20 px-2.5 py-1 text-xs font-light text-blue-300">
                {data.user.handle}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {authenticated ? (
              <button
                type="button"
                onClick={() => logout()}
                className="rounded-xl border border-white/15 px-3 py-2 text-sm font-light transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                Sign out
              </button>
            ) : (
              <button
                type="button"
                onClick={() => login()}
                className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-light transition hover:bg-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                Sign in
              </button>
            )}
          </div>
        </div>
      </header>

      <main id="main" className="relative z-10 mx-auto max-w-7xl px-4 py-8 sm:px-6">
        {!authenticated ? (
          <SignedOut onLogin={login} />
        ) : data?.needsTwitter ? (
          <NeedsTwitter />
        ) : loadState === 'error' ? (
          <LoadFailed
            message={loadError}
            onRetry={() => {
              // Clearing the error puts the page back into `loading` and bumping
              // the key re-runs the load effect.
              setLoadError(null);
              setReloadKey((k) => k + 1);
            }}
          />
        ) : loadState !== 'loaded' || !data ? (
          <DashboardSkeleton />
        ) : (
          <>
            <ProfileCard
              user={data.user}
              walletAddress={wallet?.address ?? null}
              privyEmail={
                user?.email?.address ??
                (user?.linkedAccounts?.find((a) => a.type === 'email') as { address?: string })
                  ?.address
              }
            />

            <BalanceCard
              balanceLabel={balanceLabel}
              unavailable={Boolean(wallet?.balanceError)}
              onFund={() => setFundOpen(true)}
              onWithdraw={() => setWithdrawOpen(true)}
              onRetry={() => refresh()}
              canWithdraw={Boolean(balanceLabel && Number(balanceLabel) > 0)}
            />

            <nav
              aria-label="Dashboard sections"
              // Scrolls rather than clipping. At 375px the old fixed row needed
              // ~450px and the last tabs were simply unreachable.
              className="-mx-4 mb-6 mt-8 flex gap-1 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
            >
              {(
                [
                  ['overview', 'Overview'],
                  ['activity', 'Activity'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  aria-current={tab === id ? 'page' : undefined}
                  className={`shrink-0 rounded-lg px-4 py-2.5 text-sm font-light tracking-tight transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
                    tab === id ? 'bg-white/10 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>

            {tab === 'overview' ? (
              <Overview data={data} onOpenActivity={() => setTab('activity')} />
            ) : (
              <Activity history={data.history} truncated={data.historyTruncated} />
            )}
          </>
        )}
      </main>

      {/* Rendered only while open, so each dialog gets fresh state on mount
          instead of clearing itself in an effect. */}
      {wallet?.address && fundOpen && (
        <FundDialog
          onClose={() => setFundOpen(false)}
          address={wallet.address}
          onFunded={() => refresh()}
        />
      )}
      {wallet?.address && withdrawOpen && (
        <WithdrawDialog
          onClose={() => setWithdrawOpen(false)}
          maxSol={wallet.balanceSol ?? 0}
          onWithdrawn={() => refresh()}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- sections */

function BackgroundGlow() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-purple-900/20 via-black to-black" />
      <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-purple-500/20 blur-3xl" />
      <div className="absolute -bottom-24 -left-24 h-80 w-80 rounded-full bg-blue-500/15 blur-3xl" />
    </div>
  );
}

function FullScreenStatus({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black text-white">
      <div className="text-center">
        <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white motion-reduce:animate-none" />
        <p role="status" className="font-light text-white/70">
          {message}
        </p>
      </div>
    </div>
  );
}

function SignedOut({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="mx-auto max-w-lg py-12 text-center sm:py-20">
      <h1 className="text-3xl font-extralight tracking-tight">Your tip wallet</h1>
      <p className="mx-auto mt-4 max-w-md text-sm font-light leading-relaxed text-white/70">
        Sign in with X to see tips people have sent you, fund your wallet, and send tips of your
        own. If someone already tipped you, it is waiting.
      </p>
      <button
        type="button"
        onClick={onLogin}
        className="mt-8 rounded-xl bg-blue-500 px-8 py-3 text-base font-light tracking-tight transition hover:bg-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        Sign in with X
      </button>
      <p className="mt-6 text-xs font-light text-white/40">
        Email and wallet sign-in also work.
      </p>
    </div>
  );
}

function NeedsTwitter() {
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-amber-400/20 bg-amber-500/10 p-8 text-center">
      <h2 className="text-xl font-extralight tracking-tight">Link your X account</h2>
      <p className="mt-3 text-sm font-light leading-relaxed text-white/70">
        Tips are addressed to an X handle, so we need yours before we can set up a tip wallet.
        Open the account menu and connect X to continue.
      </p>
    </div>
  );
}

function LoadFailed({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="mx-auto max-w-lg rounded-2xl border border-red-400/20 bg-red-500/10 p-8 text-center"
    >
      <h2 className="text-xl font-extralight tracking-tight">Could not load your dashboard</h2>
      <p className="mt-3 text-sm font-light leading-relaxed text-white/70">
        {message ?? 'Something went wrong.'}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 rounded-xl bg-white/10 px-5 py-2.5 text-sm font-light transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        Try again
      </button>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-32 animate-pulse rounded-2xl bg-white/5 motion-reduce:animate-none" />
      <div className="h-40 animate-pulse rounded-2xl bg-white/5 motion-reduce:animate-none" />
      <div className="h-12 w-64 animate-pulse rounded-xl bg-white/5 motion-reduce:animate-none" />
      <span className="sr-only" role="status">
        Loading your dashboard
      </span>
    </div>
  );
}

function ProfileCard({
  user,
  walletAddress,
  privyEmail,
}: {
  user: MeResponse['user'];
  walletAddress: string | null;
  privyEmail?: string;
}) {
  if (!user) return null;
  const fallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name || user.handle)}&background=3B82F6&color=fff`;

  return (
    <section className="rounded-2xl border border-white/10 bg-gradient-to-r from-purple-500/10 to-blue-500/10 p-5 backdrop-blur-sm sm:p-8">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-6">
        {/* eslint-disable-next-line @next/next/no-img-element -- remote avatar hosts vary; next/image would need each one allow-listed */}
        <img
          src={user.profileImage || fallback}
          alt=""
          width={72}
          height={72}
          className="h-16 w-16 shrink-0 rounded-full border-2 border-white/20 object-cover sm:h-18 sm:w-18"
        />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-extralight tracking-tight sm:text-3xl">
            {user.name || user.handle}
          </h1>
          <p className="truncate text-base font-light text-blue-300">{user.handle}</p>
          {privyEmail && <p className="truncate text-xs font-light text-white/40">{privyEmail}</p>}
        </div>
        {walletAddress && (
          <div className="shrink-0 sm:text-right">
            <div className="mb-1 text-xs font-light tracking-tight text-white/60">
              Tip wallet
            </div>
            <CopyButton value={walletAddress} describe="tip wallet address" />
          </div>
        )}
      </div>
    </section>
  );
}

function BalanceCard({
  balanceLabel,
  unavailable,
  onFund,
  onWithdraw,
  onRetry,
  canWithdraw,
}: {
  balanceLabel: string | null;
  unavailable: boolean;
  onFund: () => void;
  onWithdraw: () => void;
  onRetry: () => void;
  canWithdraw: boolean;
}) {
  return (
    <section className="mt-6 rounded-2xl border border-white/10 bg-gradient-to-r from-purple-500/10 to-blue-500/10 p-5 backdrop-blur-sm sm:p-8">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-light uppercase tracking-wide text-white/60">
            Tip wallet balance
          </h2>
          {unavailable ? (
            // Never render "0.0000 SOL" for a failed lookup. The old code
            // swallowed the error and left the balance at its initial 0.
            <div className="mt-2">
              <p className="text-2xl font-extralight tracking-tight text-white/60">Unavailable</p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-1 text-xs font-light text-blue-300 underline underline-offset-2 hover:text-blue-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 rounded"
              >
                Couldn&apos;t reach the network — retry
              </button>
            </div>
          ) : (
            <p className="mt-2 text-4xl font-extralight tracking-tight tabular-nums">
              {balanceLabel} <span className="text-2xl text-white/50">SOL</span>
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap gap-3">
          <button
            type="button"
            onClick={onFund}
            className="flex-1 rounded-xl bg-blue-500 px-5 py-3 text-sm font-light tracking-tight transition hover:bg-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 sm:flex-none"
          >
            Add funds
          </button>
          <button
            type="button"
            onClick={onWithdraw}
            disabled={!canWithdraw}
            title={canWithdraw ? undefined : 'Nothing to withdraw yet'}
            className="flex-1 rounded-xl border border-white/15 px-5 py-3 text-sm font-light tracking-tight transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none"
          >
            Withdraw
          </button>
        </div>
      </div>
    </section>
  );
}

function Overview({ data, onOpenActivity }: { data: MeResponse; onOpenActivity: () => void }) {
  return (
    <div className="space-y-6">
      {data.pending.length > 0 && (
        <section className="rounded-xl border border-amber-400/20 bg-amber-500/10 p-5">
          <h2 className="text-base font-light text-amber-200">
            {data.pending.length === 1 ? '1 tip on the way' : `${data.pending.length} tips on the way`}
          </h2>
          <p className="mt-1 text-sm font-light leading-relaxed text-amber-100/70">
            These were sent to you on X but haven&apos;t settled yet — usually because the sender
            still needs to fund their tip wallet. They arrive automatically, there is nothing for
            you to do.
          </p>
          <ul className="mt-4 space-y-2">
            {data.pending.slice(0, 4).map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-black/20 px-3 py-2 text-sm"
              >
                <span className="font-light text-white/80">from {p.sender}</span>
                <span className="font-medium tabular-nums text-amber-200">
                  {p.amount} {p.token}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-xl border border-white/10 bg-white/5 p-5 backdrop-blur-sm">
          <h2 className="mb-3 text-base font-light tracking-tight">How to send a tip</h2>
          <p className="text-sm font-light leading-relaxed text-white/70">
            Reply to any post on X with:
          </p>
          <code className="mt-3 block break-words rounded-lg bg-black/40 px-3 py-2 font-mono text-sm text-blue-200">
            {exampleCommand(0.5)}
          </code>
          <p className="mt-3 text-xs font-light leading-relaxed text-white/50">
            The tip goes to whoever wrote the post. Add a handle — {exampleCommand(0.5)} @someone —
            to send it elsewhere. Your tip wallet needs the funds first.
          </p>
        </section>

        <section className="rounded-xl border border-white/10 bg-white/5 p-5 backdrop-blur-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-light tracking-tight">Recent activity</h2>
            {data.history.length > 0 && (
              <button
                type="button"
                onClick={onOpenActivity}
                className="rounded text-xs font-light text-blue-300 hover:text-blue-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                See all
              </button>
            )}
          </div>
          {data.history.length === 0 ? (
            <EmptyState
              title="Nothing yet"
              body="Tips you send and receive will show up here."
            />
          ) : (
            <ul className="space-y-2">
              {/* Newest first — the server now sorts, where the old code sliced
                  the first three of an insertion-ordered array, i.e. the oldest. */}
              {data.history.slice(0, 4).map((tx, i) => (
                <li key={`${tx.txHash}-${i}`} className="flex items-center justify-between gap-3 py-1">
                  <span className="flex min-w-0 items-center gap-2 text-sm font-light">
                    <span
                      aria-hidden
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        tx.direction === 'out' ? 'bg-red-400' : 'bg-emerald-400'
                      }`}
                    />
                    <span className="truncate">
                      {tx.direction === 'out' ? 'Sent' : 'Received'} {tx.amount} {tx.token}
                    </span>
                  </span>
                  <time
                    dateTime={new Date(tx.date).toISOString()}
                    className="shrink-0 text-xs font-light text-white/50"
                  >
                    {formatDate(tx.date)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Activity({ history, truncated }: { history: HistoryItem[]; truncated?: boolean }) {
  if (history.length === 0) {
    return (
      <section className="rounded-xl border border-white/10 bg-white/5 p-10">
        <EmptyState
          title="No transactions yet"
          body="Once you send or receive a tip, it will appear here with a link to the transaction."
        />
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border border-white/10 bg-white/5 backdrop-blur-sm">
      <ul className="divide-y divide-white/10">
        {history.map((tx, i) => (
          <li key={`${tx.txHash}-${i}`} className="p-4 transition hover:bg-white/5 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm ${
                    tx.direction === 'out'
                      ? 'bg-red-500/15 text-red-300'
                      : 'bg-emerald-500/15 text-emerald-300'
                  }`}
                >
                  {tx.direction === 'out' ? 'â†‘' : 'â†“'}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-light">
                    {tx.direction === 'out' ? 'Sent to' : 'Received from'}{' '}
                    <span className="text-white/90">{formatCounterparty(tx.counterparty)}</span>
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs font-light text-white/50">
                    <time dateTime={new Date(tx.date).toISOString()}>{formatDate(tx.date)}</time>
                    <span aria-hidden>Â·</span>
                    <a
                      href={tx.explorerUrl ?? `https://solscan.io/tx/${tx.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded font-mono text-blue-300 hover:text-blue-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                    >
                      {/* Truncated: a full 88-character signature used to be
                          rendered inline and blew the row out of the viewport. */}
                      {truncateMiddle(tx.txHash, 6, 6)}
                    </a>
                    {tx.status === 'unconfirmed' && (
                      <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
                        Unconfirmed
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <p
                className={`shrink-0 text-sm font-light tabular-nums ${
                  tx.direction === 'out' ? 'text-red-300' : 'text-emerald-300'
                }`}
              >
                {tx.direction === 'out' ? 'âˆ’' : '+'}
                {tx.amount} {tx.token}
              </p>
            </div>
          </li>
        ))}
      </ul>
      {truncated && (
        <p className="border-t border-white/10 px-5 py-3 text-xs font-light text-white/40">
          Showing your most recent 100 transactions.
        </p>
      )}
    </section>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="py-4 text-center">
      <p className="text-sm font-light text-white/70">{title}</p>
      <p className="mx-auto mt-1 max-w-xs text-xs font-light leading-relaxed text-white/40">
        {body}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ format */

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatDate(value: string | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return dateFormatter.format(date);
}

/** Counterparties are either an @handle or a raw address; only truncate addresses. */
function formatCounterparty(value: string): string {
  return value.startsWith('@') ? value : truncateMiddle(value, 4, 4);
}
