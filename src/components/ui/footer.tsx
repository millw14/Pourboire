import Link from 'next/link';
import { CopyButton } from './copy-button';

/**
 * The $POURBOIRE token address.
 *
 * This is a **Solana** mint and it stays one — the token was launched there and
 * moving the app to Robinhood Chain does not move the token. It therefore links
 * to Solscan, not to this chain's explorer, where the address would simply 404.
 * If a Robinhood Chain token is ever deployed, this becomes two entries rather
 * than one edited in place.
 */
const TOKEN_ADDRESS = 'jwByd6QTKh94rhz9TtGrf97cNisrrQtXR1MRJ9cpump';
const TOKEN_EXPLORER = `https://solscan.io/token/${TOKEN_ADDRESS}`;

export default function Footer() {
  return (
    <footer className="w-full border-t border-white/10 bg-black/40 backdrop-blur-sm">
      <div className="mx-auto max-w-7xl px-6 py-10 md:px-10 lg:px-16">
        <div className="flex flex-col items-center gap-8 md:flex-row md:items-start md:justify-between">
          <div className="text-center md:text-left">
            <p className="text-sm font-light text-white/80">Pourboire</p>
            <p className="mt-1 text-xs font-light text-white/50">
              Tip anyone on X, on Robinhood Chain.
            </p>
            <p className="mt-3 text-xs font-light text-white/40">
              © {new Date().getFullYear()} Pourboire
            </p>
          </div>

          <div className="flex flex-col items-center gap-2 md:items-end">
            <span className="text-xs font-light text-white/50">$POURBOIRE on Solana</span>
            <CopyButton
              value={TOKEN_ADDRESS}
              describe="token contract address"
              className="bg-white/5 text-white/80"
            />
            <a
              href={TOKEN_EXPLORER}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded text-xs font-light text-blue-300 transition hover:text-blue-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              View on Solscan ↗
            </a>
          </div>

          <nav aria-label="Footer" className="flex items-center gap-5 text-sm font-light">
            <a
              href="https://x.com/Pourboireonsol"
              target="_blank"
              rel="noopener noreferrer"
              className="rounded text-white/70 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              X
            </a>
            <Link
              href="/privacy"
              className="rounded text-white/70 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              Privacy
            </Link>
            <Link
              href="/terms"
              className="rounded text-white/70 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              Terms
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
