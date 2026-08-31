import 'server-only';
import type { CurrencyCode } from './currencies';

/**
 * The seam between this app and whoever actually holds the licences.
 *
 * Pourboire does not and will not move fiat itself. Converting a stablecoin
 * balance to a local bank account, or issuing a card that spends it, is money
 * transmission — it needs licensing, cardholder KYC/AML, and a card scheme
 * relationship. That work belongs to a provider (Rain and Reap issue as their
 * own issuer of record; Eversend, Conduit and Yativo cover local payout rails),
 * and using one is the difference between a compliant product and an
 * unlicensed one.
 *
 * Everything below is the shape such a provider has to satisfy. No provider is
 * wired in yet, because integrating one requires a signed agreement and KYB
 * that only a human can complete. Until then `activeProvider()` returns null and
 * every route that needs one answers 503 rather than pretending.
 *
 * Two invariants this interface exists to enforce:
 *
 *  1. **Identity before payout.** A tip can be received by an X handle with no
 *     identity attached — that is the whole product. Fiat cannot. Every method
 *     that moves value takes a verified subject, not a handle.
 *  2. **The provider owns the quote.** Rates in `./rates` are indicative only.
 *     The number a user is held to comes from `quotePayout`, expires, and is
 *     referenced by id when the payout is created.
 */

export type VerificationStatus =
  /** Never started. */
  | 'unstarted'
  /** Submitted, provider is reviewing. */
  | 'pending'
  /** Provider needs something more from the user. */
  | 'action_required'
  | 'verified'
  | 'rejected';

export interface VerificationSession {
  status: VerificationStatus;
  /** Provider-hosted flow. We never collect identity documents ourselves. */
  hostedUrl?: string;
  providerRef: string;
  /** Present when rejected or action_required, safe to show the user. */
  reason?: string;
}

export interface PayoutQuote {
  id: string;
  /** Stablecoin leaving the tip wallet, in base units. */
  sourceAmount: string;
  sourceToken: string;
  currency: CurrencyCode;
  /** What lands, in minor units of the local currency. */
  destinationAmount: string;
  /** Provider's rate, inclusive of spread. Not the indicative rate. */
  rate: number;
  /** Provider fee in minor units of the local currency. */
  fee: string;
  expiresAt: Date;
}

export interface PayoutRequest {
  quoteId: string;
  subjectRef: string;
  destination: {
    kind: 'bank' | 'mobile_money';
    accountNumber: string;
    bankCode?: string;
    accountName: string;
  };
}

export interface PayoutResult {
  providerRef: string;
  status: 'pending' | 'paid' | 'failed';
  reason?: string;
}

export interface IssuedCard {
  providerRef: string;
  status: 'pending' | 'active' | 'frozen' | 'closed';
  /** Last four only. Full PAN is never stored or proxied through this app. */
  last4?: string;
  brand?: 'visa' | 'mastercard';
  expiryMonth?: number;
  expiryYear?: number;
  /**
   * Provider-hosted URL that reveals the full card details directly to the
   * cardholder. PCI scope stays with the provider; we only ever hold a link.
   */
  detailsUrl?: string;
}

export interface FiatProvider {
  readonly name: string;
  /** Currencies this provider can actually pay out in. */
  readonly payoutCurrencies: readonly CurrencyCode[];
  readonly supportsCards: boolean;

  startVerification(params: {
    userId: string;
    email?: string;
    handle: string;
    returnUrl: string;
  }): Promise<VerificationSession>;

  getVerification(providerRef: string): Promise<VerificationSession>;

  quotePayout(params: {
    subjectRef: string;
    sourceAmount: string;
    sourceToken: string;
    currency: CurrencyCode;
  }): Promise<PayoutQuote>;

  createPayout(request: PayoutRequest): Promise<PayoutResult>;

  issueCard(params: { subjectRef: string }): Promise<IssuedCard>;
  getCard(providerRef: string): Promise<IssuedCard>;
}

/**
 * The configured provider, or null when none is.
 *
 * Deliberately returns null rather than falling back to a stub in production: a
 * stub that issues fake card numbers or reports fake payouts is worse than an
 * unavailable feature, because it looks like it worked.
 */
export function activeProvider(): FiatProvider | null {
  // When a provider is contracted, construct it here from its credentials —
  // e.g. `if (process.env.RAIN_API_KEY) return new RainProvider(...)`.
  return null;
}

/** Is the fiat side available at all? Drives the UI's gating. */
export function fiatEnabled(): boolean {
  return activeProvider() !== null;
}
