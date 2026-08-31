import Hero from '@/components/ui/neural-network-hero';
import { HowItWorks } from '@/components/ui/how-it-works';
import { TipDemo } from '@/components/ui/tip-demo';
import Footer from '@/components/ui/footer';

/**
 * The landing page is now a plain server component with no providers above it.
 * It used to be rendered inside PrivyProvider and WalletProvider, so visiting
 * the homepage downloaded the entire wallet stack — and a Privy failure replaced
 * this page with an "Authentication Error" screen.
 */
export default function Home() {
  return (
    <div className="flex min-h-screen w-full flex-col">
      <main id="main" className="flex-1">
        <Hero
          title="Tip anyone on X, in dollars"
          description="Reply to any post with @Pourboireonsol and an amount. They don't need a wallet — if they haven't signed up, we hold the tip until they do."
          badgeText="Robinhood Chain"
          badgeLabel="Live"
          ctaButtons={[
            { text: 'Open your wallet', href: '/dashboard', primary: true },
            { text: 'How it works', href: '#how-it-works' },
          ]}
          microDetails={['Settles in seconds', 'No wallet needed to receive', 'Network fees only']}
        />

        <HowItWorks />
        <TipDemo />
      </main>

      <Footer />
    </div>
  );
}
