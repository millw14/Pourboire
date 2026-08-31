import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import connectDB from '@/lib/mongodb';
import User, { type ITransaction } from '@/models/User';
import Giveaway from '@/models/Giveaway';
import { normalizeHandle } from '@/lib/auth';
import { formatAmount, tokenFromRecord, type TokenInfo } from '@/lib/tokens';
import { exampleCommand } from '@/lib/tip-command';
import { CopyButton } from '@/components/ui/copy-button';
import Footer from '@/components/ui/footer';

/**
 * A public page per creator: pourboire.tips/@alice
 *
 * **Privacy line.** Only *received tips* are shown. Every one of those was
 * already announced publicly on X by the bot, so this discloses nothing new.
 * Withdrawals, transfers out, balances and pending claims are deliberately never
 * rendered here — an earlier version of this app leaked exactly that by wallet
 * address, and it is not the sort of thing to reintroduce for a leaderboard.
 */

export const revalidate = 300;

interface Props {
  params: Promise<{ handle: string }>;
}

function decodeHandle(raw: string): string | null {
  const decoded = decodeURIComponent(raw);
  // Only `@name` paths are profiles. Anything else falls through to a 404 so
  // this dynamic segment cannot shadow real routes.
  if (!decoded.startsWith('@')) return null;
  if (!/^@[A-Za-z0-9_]{1,15}$/.test(decoded)) return null;
  return normalizeHandle(decoded);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle: raw } = await params;
  const handle = decodeHandle(raw);
  if (!handle) return { title: 'Not found' };
  return {
    title: `${handle} on Pourboire`,
    description: `Tip ${handle} on X, on Robinhood Chain.`,
  };
}

interface TokenTotal {
  token: TokenInfo;
  received: bigint;
  count: number;
}

export default async function ProfilePage({ params }: Props) {
  const { handle: raw } = await params;
  const handle = decodeHandle(raw);
  if (!handle) notFound();

  await connectDB();
  const user = await User.findOne({ handle }).lean();
  if (!user) notFound();

  // Received only. See the privacy note at the top of this file.
  const received = (user.history ?? []).filter(
    (h: ITransaction) => h.direction === 'in' && h.status !== 'failed'
  );

  const byToken = new Map<string, TokenTotal>();
  const byTipper = new Map<string, { count: number }>();

  for (const tx of received) {
    const token = tokenFromRecord(tx);
    const key = token.symbol;
    const entry = byToken.get(key) ?? { token, received: 0n, count: 0 };
    entry.received += BigInt(tx.amount);
    entry.count += 1;
    byToken.set(key, entry);

    if (tx.counterparty.startsWith('@')) {
      const tipper = byTipper.get(tx.counterparty) ?? { count: 0 };
      tipper.count += 1;
      byTipper.set(tx.counterparty, tipper);
    }
  }

  const totals = [...byToken.values()].sort((a, b) => b.count - a.count);
  const topTippers = [...byTipper.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8);

  const recent = [...received]
    .sort((a, b) => +new Date(b.date) - +new Date(a.date))
    .slice(0, 12);

  const giveaways = await Giveaway.find({ creatorHandle: handle, status: 'settled' })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

  const name = user.name && user.name !== handle.replace(/^@/, '') ? user.name : handle;

  return (
    <div className="flex min-h-screen flex-col bg-black text-white">
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-purple-900/20 via-black to-black" />
        <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-purple-500/15 blur-3xl" />
      </div>

      <main id="main" className="relative z-10 mx-auto w-full max-w-3xl flex-1 px-6 py-16">
        <Link
          href="/"
          className="rounded text-sm font-light text-white/50 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          ← Pourboire
        </Link>

        <header className="mt-8 flex flex-col gap-5 sm:flex-row sm:items-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- avatar hosts vary; next/image would need each allow-listed */}
          <img
            src={
              user.profileImage ||
              `https://ui-avatars.com/api/?name=${encodeURIComponent(handle.replace(/^@/, ''))}&background=3B82F6&color=fff`
            }
            alt=""
            width={80}
            height={80}
            className="h-20 w-20 shrink-0 rounded-full border-2 border-white/15 object-cover"
          />
          <div className="min-w-0">
            <h1 className="truncate text-3xl font-extralight tracking-tight">{name}</h1>
            <a
              href={`https://x.com/${handle.replace(/^@/, '')}`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded text-blue-300 transition hover:text-blue-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              {handle} ↗
            </a>
          </div>
        </header>

        {/* ------------------------------------------------------- totals */}
        {totals.length > 0 ? (
          <section className="mt-10 grid gap-3 sm:grid-cols-2">
            {totals.map((t) => (
              <div
                key={t.token.symbol}
                className="rounded-xl border border-white/10 bg-white/5 p-5"
                style={{ borderLeftColor: t.token.color, borderLeftWidth: 3 }}
              >
                <p className="text-xs font-light uppercase tracking-wide text-white/45">
                  Received
                </p>
                <p className="mt-1 text-2xl font-extralight tabular-nums">
                  {formatAmount(t.received, t.token)}
                </p>
                <p className="mt-1 text-xs font-light text-white/40">
                  across {t.count} tip{t.count === 1 ? '' : 's'}
                </p>
              </div>
            ))}
          </section>
        ) : (
          <section className="mt-10 rounded-xl border border-white/10 bg-white/5 p-8 text-center">
            <p className="text-sm font-light text-white/70">No tips yet</p>
            <p className="mt-1 text-xs font-light text-white/40">Be the first.</p>
          </section>
        )}

        {/* --------------------------------------------------- how to tip */}
        <section className="mt-8 rounded-xl border border-white/10 bg-white/5 p-5">
          <h2 className="text-sm font-medium uppercase tracking-wide text-white/40">
            Tip {handle}
          </h2>
          <p className="mt-3 text-sm font-light leading-relaxed text-white/70">
            Reply to any of their posts on X with:
          </p>
          <div className="mt-3">
            <CopyButton
              value={exampleCommand(0.5)}
              label={exampleCommand(0.5)}
              describe="tip command"
              className="bg-black/40 px-3 py-2 text-blue-200"
            />
          </div>
        </section>

        {/* ------------------------------------------------- top tippers */}
        {topTippers.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-white/40">
              Top tippers
            </h2>
            <div className="flex flex-wrap gap-2">
              {topTippers.map(([tipper, stats]) => (
                <a
                  key={tipper}
                  href={`/${encodeURIComponent(tipper)}`}
                  className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-light transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  {tipper} <span className="text-white/40">×{stats.count}</span>
                </a>
              ))}
            </div>
          </section>
        )}

        {/* --------------------------------------------------- giveaways */}
        {giveaways.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-white/40">
              Giveaways run
            </h2>
            <ul className="divide-y divide-white/10 overflow-hidden rounded-xl border border-white/10">
              {giveaways.map((g) => {
                const token = tokenFromRecord(g);
                return (
                  <li key={g.tweetId}>
                    <a
                      href={`/giveaway/${g.tweetId}`}
                      className="flex items-center justify-between gap-3 px-4 py-3 transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                    >
                      <span className="text-sm font-light">
                        {formatAmount(BigInt(g.totalAmount), token)} to {g.winners.length} winners
                      </span>
                      <span className="text-xs font-light text-blue-300">Verify →</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* ------------------------------------------------- recent tips */}
        {recent.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-white/40">
              Recent tips
            </h2>
            <ul className="divide-y divide-white/10 overflow-hidden rounded-xl border border-white/10">
              {recent.map((tx, i) => {
                const token = tokenFromRecord(tx);
                return (
                  <li
                    key={`${tx.txHash}-${i}`}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                  >
                    <span className="text-sm font-light text-white/75">
                      from {tx.counterparty}
                    </span>
                    <span className="text-sm font-light tabular-nums text-emerald-300">
                      {formatAmount(BigInt(tx.amount), token)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>
      <Footer />
    </div>
  );
}
