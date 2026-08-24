import type { Metadata } from 'next';

// Static text; no client bundle needed. See the note in privacy/page.tsx.
export const metadata: Metadata = { title: 'Terms of Service' };

export default function TermsOfServicePage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <div className="max-w-3xl mx-auto px-6 md:px-8 py-16">
        <h1 className="text-4xl font-extralight tracking-tight mb-6">Terms of Service</h1>
        <p className="text-white/70 mb-8">Last updated: October 30, 2025</p>

        <section className="space-y-6 text-white/80 leading-relaxed">
          <p>
            These Terms govern your access to and use of Pourboire (the &ldquo;Service&rdquo;). By using the Service,
            you agree to these Terms.
          </p>

          <h2 className="text-2xl text-white font-medium mt-8">Accounts and Access</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>You must be legally capable of entering into a contract in your jurisdiction.</li>
            <li>
              You are responsible for maintaining the security of your accounts, devices, and any wallets
              connected via Privy or otherwise.
            </li>
          </ul>

          <h2 className="text-2xl text-white font-medium mt-8">Blockchain and Custodial Wallets</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              On-chain transactions are irreversible. You acknowledge the risks inherent to blockchain,
              including network fees, delays, forks, and smart contract bugs.
            </li>
            <li>
              For recipients without a connected wallet, the Service may create a custodial wallet. Keys are
              encrypted, but you remain responsible for safeguarding access to your account.
            </li>
          </ul>

          <h2 className="text-2xl text-white font-medium mt-8">Prohibited Conduct</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>Illegal activity, fraud, money laundering, sanctions violations.</li>
            <li>Abuse, spam, or attempts to disrupt the Service.</li>
            <li>Violation of third-party terms (e.g., X/Twitter policies).</li>
          </ul>

          <h2 className="text-2xl text-white font-medium mt-8">No Warranties</h2>
          <p>
            The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo; without warranties of any kind, express or
            implied, including merchantability, fitness for a particular purpose, and non-infringement.
          </p>

          <h2 className="text-2xl text-white font-medium mt-8">Limitation of Liability</h2>
          <p>
            To the fullest extent permitted by law, Pourboire and its affiliates will not be liable for any
            indirect, incidental, special, consequential, or punitive damages, or any loss of profits or
            revenues, whether incurred directly or indirectly, or any loss of data, use, goodwill, or other
            intangible losses.
          </p>

          <h2 className="text-2xl text-white font-medium mt-8">Fees</h2>
          <p>
            You are responsible for network fees and any third-party fees. We currently charge no platform
            fee, but reserve the right to introduce fees with notice.
          </p>

          <h2 className="text-2xl text-white font-medium mt-8">Changes</h2>
          <p>
            We may modify these Terms. Continued use of the Service after changes constitutes acceptance of
            the updated Terms.
          </p>

          <h2 className="text-2xl text-white font-medium mt-8">Termination</h2>
          <p>
            We may suspend or terminate access for violations of these Terms or risk to the Service.
          </p>

          <h2 className="text-2xl text-white font-medium mt-8">Governing Law</h2>
          <p>
            These Terms are governed by applicable laws of the jurisdiction in which we operate, without
            regard to conflict of law principles.
          </p>

          <h2 className="text-2xl text-white font-medium mt-8">Contact</h2>
          <p>
            For terms questions, contact: legal@pourboire.app
          </p>
        </section>
      </div>
    </main>
  );
}


