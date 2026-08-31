import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import connectDB from '@/lib/mongodb';
import Giveaway from '@/models/Giveaway';
import { commitmentFor, drawWinners, verifyCommitment } from '@/lib/draw';
import { formatAmount, tokenFromRecord } from '@/lib/tokens';
import { explorerTxUrl } from '@/lib/chain';
import Footer from '@/components/ui/footer';

/**
 * The page that makes "provably fair" a claim anyone can check rather than one
 * they have to take on faith.
 *
 * It shows the commitment published before entries opened, the on-chain beacon
 * that decided the draw, the full entry list, and the algorithm — and it
 * re-runs the draw server-side so a mismatch between the stored winners and a
 * fresh computation is displayed rather than hidden.
 */

export const revalidate = 60;

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Giveaway ${id}`,
    description: 'Verify the winners of a Pourboire giveaway.',
  };
}

export default async function GiveawayPage({ params }: Props) {
  const { id } = await params;

  await connectDB();
  const giveaway = await Giveaway.findOne({ tweetId: id }).lean();
  if (!giveaway) notFound();

  const token = tokenFromRecord(giveaway);

  const drawn = giveaway.status === 'settled' || giveaway.status === 'drawn';
  const total = formatAmount(BigInt(giveaway.totalAmount), token);

  // Independently recompute the draw. If this disagrees with what was paid, the
  // page says so — a verification page that cannot fail verifies nothing.
  let recomputed: string[] | null = null;
  let commitmentOk: boolean | null = null;
  if (drawn && giveaway.seed && giveaway.beaconHash) {
    commitmentOk = verifyCommitment(giveaway.seed, giveaway.seedCommitment);
    recomputed = drawWinners({
      seed: giveaway.seed,
      beacon: giveaway.beaconHash,
      entries: giveaway.entries,
      winners: giveaway.winnerCount,
    });
  }

  const paidHandles = giveaway.winners.map((w) => w.handle);
  const matches =
    recomputed !== null &&
    paidHandles.length === recomputed.length &&
    paidHandles.every((h, i) => h === recomputed![i]);

  return (
    <div className="flex min-h-screen flex-col bg-black text-white">
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
        <Link
          href="/"
          className="rounded text-sm font-light text-white/50 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          ← Pourboire
        </Link>

        <header className="mt-8">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-extralight tracking-tight sm:text-4xl">{total} giveaway</h1>
            <StatusBadge status={giveaway.status} />
          </div>
          <p className="mt-2 text-sm font-light text-white/60">
            by {giveaway.creatorHandle} · {giveaway.winnerCount} winner
            {giveaway.winnerCount === 1 ? '' : 's'} ·{' '}
            <a
              href={`https://x.com/i/status/${giveaway.tweetId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded text-blue-300 hover:text-blue-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              original post ↗
            </a>
          </p>
        </header>

        {drawn && (
          <div
            className={`mt-8 rounded-xl border p-5 ${
              matches && commitmentOk
                ? 'border-emerald-400/25 bg-emerald-500/10'
                : 'border-red-400/25 bg-red-500/10'
            }`}
          >
            <p className="text-sm font-medium">
              {matches && commitmentOk
                ? '✓ Verified — recomputing the draw reproduces exactly these winners'
                : '⚠ Mismatch — the recorded winners do not match a fresh computation'}
            </p>
            <p className="mt-1 text-xs font-light leading-relaxed text-white/60">
              {commitmentOk === false
                ? 'The revealed seed does not hash to the published commitment.'
                : 'The seed below hashes to the commitment that was published before entries opened, and combining it with the on-chain beacon yields the winner list.'}
            </p>
          </div>
        )}

        <Section title="How this works">
          <ol className="space-y-3 text-sm font-light leading-relaxed text-white/70">
            <li>
              <strong className="font-medium text-white">1. Commit.</strong> Before entries opened,
              a random seed was generated and only its SHA-256 hash was published. Nobody could
              predict the draw from a hash.
            </li>
            <li>
              <strong className="font-medium text-white">2. Beacon.</strong> After entries closed,
              the hash of a settled Robinhood Chain block was taken. That value did not exist when the
              seed was committed, so the seed could not have been chosen to favour anyone.
            </li>
            <li>
              <strong className="font-medium text-white">3. Reveal.</strong> The seed is published
              below. <code className="text-blue-200">HMAC-SHA256(seed, beacon)</code> drives a
              Fisher-Yates shuffle over the sorted entry list, with rejection sampling so no index
              is favoured. Anyone can rerun it.
            </li>
          </ol>
        </Section>

        <Section title="Proof">
          <dl className="space-y-4">
            <Proof label="Seed commitment (published before entries)" value={giveaway.seedCommitment} />
            <Proof
              label="Revealed seed"
              value={giveaway.seed && drawn ? giveaway.seed : 'Hidden until the draw'}
            />
            {giveaway.seed && drawn && (
              <Proof label="SHA-256 of revealed seed" value={commitmentFor(giveaway.seed)} />
            )}
            <Proof label="Beacon slot" value={giveaway.beaconSlot?.toString() ?? 'Not drawn yet'} />
            <Proof label="Beacon blockhash" value={giveaway.beaconHash ?? 'Not drawn yet'} />
          </dl>
        </Section>

        <Section title={`Winners${drawn ? ` (${giveaway.winners.length})` : ''}`}>
          {!drawn ? (
            <p className="text-sm font-light text-white/50">
              Entries close {new Date(giveaway.closesAt).toUTCString()}.
            </p>
          ) : giveaway.winners.length === 0 ? (
            <p className="text-sm font-light text-white/50">
              {giveaway.note ?? 'No winners were paid.'}
            </p>
          ) : (
            <ul className="divide-y divide-white/10 overflow-hidden rounded-xl border border-white/10">
              {giveaway.winners.map((w, i) => (
                <li
                  key={w.handle}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                >
                  <span className="flex items-center gap-3 text-sm font-light">
                    <span className="w-6 text-white/35 tabular-nums">{i + 1}</span>
                    <a
                      href={`https://x.com/${w.handle.replace(/^@/, '')}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded hover:text-blue-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                    >
                      {w.handle}
                    </a>
                  </span>
                  <span className="text-sm font-light tabular-nums text-emerald-300">
                    {formatAmount(BigInt(w.amount), token)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {giveaway.payoutTxHashes.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-3">
              {giveaway.payoutTxHashes.map((tx) => (
                <a
                  key={tx}
                  href={explorerTxUrl(tx)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg border border-white/10 px-3 py-1.5 font-mono text-xs text-blue-300 transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  {tx.slice(0, 8)}…{tx.slice(-8)} ↗
                </a>
              ))}
            </div>
          )}
        </Section>

        <Section title={`Entries (${giveaway.entries.length})`}>
          {giveaway.entries.length === 0 ? (
            <p className="text-sm font-light text-white/50">Not collected yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {/* Sorted, because that is the exact order the draw shuffles. */}
              {[...giveaway.entries].sort().map((handle) => (
                <span
                  key={handle}
                  className={`rounded-lg px-2.5 py-1 text-xs font-light ${
                    paidHandles.includes(handle)
                      ? 'bg-emerald-500/15 text-emerald-200'
                      : 'bg-white/5 text-white/50'
                  }`}
                >
                  {handle}
                </span>
              ))}
            </div>
          )}
        </Section>
      </main>
      <Footer />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-white/40">{title}</h2>
      {children}
    </section>
  );
}

function Proof({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-light text-white/45">{label}</dt>
      <dd className="mt-1 break-all rounded-lg bg-white/5 px-3 py-2 font-mono text-xs text-white/80">
        {value}
      </dd>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    open: 'bg-blue-500/20 text-blue-300',
    drawn: 'bg-amber-500/20 text-amber-300',
    settled: 'bg-emerald-500/20 text-emerald-300',
    void: 'bg-white/10 text-white/50',
  };
  const labels: Record<string, string> = {
    open: 'Entries open',
    drawn: 'Drawn',
    settled: 'Paid',
    void: 'Cancelled',
  };
  return (
    <span
      className={`rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wide ${styles[status] ?? styles.void}`}
    >
      {labels[status] ?? status}
    </span>
  );
}
