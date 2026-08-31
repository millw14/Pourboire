import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

/**
 * The root layout deliberately mounts NO providers.
 *
 * It used to wrap every route in PrivyProvider + WalletProvider, which pulled
 * Privy, WalletConnect, the Coinbase SDK, viem, libphonenumber and
 * styled-components into the bundle for the marketing pages as well — around
 * 5MB of JavaScript to render a headline and a footer. Worse, when Privy failed
 * to initialise the error boundary replaced the entire site, landing page
 * included, with "Authentication Error".
 *
 * Those providers now live in the dashboard layout, which is the only place that
 * needs a wallet.
 */

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
  display: 'swap',
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
});

const SITE_URL = 'https://pourboire.tips';
const DESCRIPTION =
  'Reply to any post on X with @Pourboireonsol to send a dollar tip. If they have not signed up yet, we hold it for them.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Pourboire — Tip anyone on X, on Robinhood Chain',
    template: '%s · Pourboire',
  },
  description: DESCRIPTION,
  openGraph: {
    title: 'Pourboire — Tip anyone on X, on Robinhood Chain',
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: 'Pourboire',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Pourboire — Tip anyone on X, on Robinhood Chain',
    description: DESCRIPTION,
    site: '@Pourboireonsol',
  },
  // The favicon comes from src/app/favicon.ico, which the App Router picks up
  // automatically. The 1000x1000 logo is only worth downloading for the
  // touch icon and the social card, not for a 16px tab icon.
  icons: { apple: '/pour.png' },
};

export const viewport: Viewport = {
  themeColor: '#000000',
  // The dashboard has 16px inputs, so iOS will not zoom on focus; allowing user
  // scaling keeps the page accessible to anyone who needs to zoom.
  width: 'device-width',
  initialScale: 1,
};

const STRUCTURED_DATA = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'Pourboire',
  description: DESCRIPTION,
  url: SITE_URL,
  sameAs: ['https://x.com/Pourboireonsol'],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="bg-black">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-black"
        >
          Skip to content
        </a>
        {children}
        <script
          type="application/ld+json"
          // Static, author-controlled JSON — no user input reaches this.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
        />
      </body>
    </html>
  );
}
