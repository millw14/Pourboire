import type { Metadata } from 'next';

// No 'use client': this page is static text with no interactivity, so it has no
// reason to ship a client bundle or opt out of static rendering.
export const metadata: Metadata = { title: 'Privacy Policy' };

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <div className="max-w-3xl mx-auto px-6 md:px-8 py-16">
        <h1 className="text-4xl font-extralight tracking-tight mb-6">Privacy Policy</h1>
        <p className="text-white/70 mb-8">Last updated: October 30, 2025</p>

        <section className="space-y-6 text-white/80 leading-relaxed">
          <p>
            Pourboire (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) respects your privacy. This policy explains what information we
            collect, how we use it, and your choices. By using our website or app, you agree to this policy.
          </p>

          <h2 className="text-2xl text-white font-medium mt-8">Information We Collect</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              Account information: If you authenticate with Privy, we receive user identifiers and any
              connected accounts metadata (e.g., email, Twitter handle) as permitted by Privy.
            </li>
            <li>
              Wallet information: Public blockchain addresses and on-chain activity related to tips processed
              through the app.
            </li>
            <li>
              Usage data: Basic analytics (pages visited, interactions) to improve the product.
            </li>
            <li>
              Database records: If a custodial tip wallet is auto-created for a recipient, we store the
              encrypted private key and required metadata securely.
            </li>
          </ul>

          <h2 className="text-2xl text-white font-medium mt-8">How We Use Information</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>Provide core features: authentication, sending/receiving tips, pending claims, auto-pay.</li>
            <li>Improve reliability, prevent abuse, and troubleshoot issues.</li>
            <li>Comply with legal obligations and enforce our Terms.</li>
          </ul>

          <h2 className="text-2xl text-white font-medium mt-8">Sharing</h2>
          <p>
            We do not sell personal information. We share data with service providers (e.g., Privy for auth,
            infrastructure providers, analytics) strictly to operate the service. On-chain transactions are
            public by design.
          </p>

          <h2 className="text-2xl text-white font-medium mt-8">Data Security</h2>
          <p>
            We use industry-standard security practices. Custodial private keys are encrypted using
            libsodium. No method is 100% secure; please use strong passwords and enable security best
            practices.
          </p>

          <h2 className="text-2xl text-white font-medium mt-8">Data Retention</h2>
          <p>
            We retain information as needed to provide the service and as required by law. You may request
            deletion of your account where applicable; some records may be retained for compliance and audit.
          </p>

          <h2 className="text-2xl text-white font-medium mt-8">Your Choices</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>Disconnect accounts via Privy.</li>
            <li>Request access or deletion by contacting us.</li>
          </ul>

          <h2 className="text-2xl text-white font-medium mt-8">Third Parties</h2>
          <p>
            Our service may link to third-party sites and wallets. Their privacy practices are governed by
            their policies.
          </p>

          <h2 className="text-2xl text-white font-medium mt-8">Children</h2>
          <p>Our service is not directed to children under 13 and does not knowingly collect their data.</p>

          <h2 className="text-2xl text-white font-medium mt-8">Changes</h2>
          <p>
            We may update this policy. We will revise the “Last updated” date and, where appropriate, notify
            you.
          </p>

          <h2 className="text-2xl text-white font-medium mt-8">Contact</h2>
          <p>
            For privacy questions or requests, contact: privacy@pourboire.app
          </p>
        </section>
      </div>
    </main>
  );
}


