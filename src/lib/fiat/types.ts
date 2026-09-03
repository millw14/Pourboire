import type { Corridor } from './corridors.ts';
import type { VerifiedSubject, VerificationStatus } from './subject.ts';

/**
 * The seam between this app and whoever actually holds the licences.
 *
 * Pourboire does not and will not move fiat itself. Converting a stablecoin
 * balance to a local bank account, or issuing a card that spends it, is money
 * transmission — it needs licensing, cardholder KYC/AML, and a card scheme
 * relationship. That work belongs to a provider, and using one is the difference
 * between a compliant product and an unlicensed one.
 *
 * Everything below is the shape such a provider has to satisfy. No provider is
 * wired in yet, because integrating one requires a signed agreement and KYB that
 * only a human can complete. Until then the registry is empty and every route
 * that needs one answers with a reason rather than pretending.
 *
 * Two invariants these interfaces exist to enforce:
 *
 *  1. **Identity before payout.** A tip can be received by an X handle with no
 *     identity attached — that is the whole product. Fiat cannot. Every method
 *     that moves value takes a `VerifiedSubject`, which has exactly one
 *     constructor, so a route that forgets to check does not compile.
 *  2. **The provider owns the quote.** Rates in `./rates` are indicative only.
 *     The number a user is held to comes from `quote()`, expires, and is
 *     referenced by id when the payout is created.
 *
 * Split into three interfaces rather than one, because a vendor's card product
 * and payout product are different APIs even when they are the same vendor. A
 * fused interface forces every adapter to throw "not supported" from half its
 * methods, which is precisely the looks-like-it-worked failure this file exists
 * to prevent.
 */

/* ------------------------------------------------------------------ common */

/**
 * Whether a failure is safe to act on.
 *
 * `definite` means the provider refused before doing anything — the request is
 * known not to have taken effect, so a different provider may be tried. Anything
 * else is indeterminate and must be looked up by idempotency key, never resent.
 */
export interface ProviderRefusal {
  definite: boolean;
  code?: string;
  message: string;
}

export class ProviderError extends Error {
  readonly refusal: ProviderRefusal;
  constructor(refusal: ProviderRefusal) {
    super(refusal.message);
    this.name = 'ProviderError';
    this.refusal = refusal;
  }
}

/* ---------------------------------------------------------------- identity */

export interface VerificationSession {
  status: VerificationStatus;
  /** Provider-hosted flow. We never collect identity documents ourselves. */
  hostedUrl?: string;
  providerRef: string;
  /** Present when rejected or action_required, safe to show the user. */
  reason?: string;
  /** ISO 3166-1 alpha-2, once the provider has established it. */
  country?: string;
}

export interface IdentityProvider {
  readonly name: string;

  startVerification(params: {
    userId: string;
    email?: string;
    handle: string;
    country?: string;
    returnUrl: string;
  }): Promise<VerificationSession>;

  getVerification(providerRef: string): Promise<VerificationSession>;
}

/* ------------------------------------------------------------------ payout */

export interface PayoutQuote {
  id: string;
  /** Stablecoin leaving the tip wallet, in base units of `sourceToken`. */
  sourceAmount: string;
  sourceToken: string;
  corridor: Corridor;
  /** What lands, in minor units of the corridor currency. */
  destinationAmount: string;
  /** Provider's rate, inclusive of spread. Not the indicative rate. */
  rate: number;
  /** Provider fee, in minor units of the corridor currency. */
  fee: string;
  expiresAt: Date;
}

/**
 * A beneficiary the provider has tokenised.
 *
 * Account numbers are posted once, to the provider, and never persisted here —
 * so a payout references `ref` and a human recognises it by `label`/`last4`.
 */
export interface PayoutDestinationRef {
  ref: string;
  label: string;
  last4?: string;
}

export interface PayoutSubmission {
  providerRef: string;
  status: 'pending' | 'paid' | 'failed';
  reason?: string;
}

export interface PayoutProvider {
  readonly name: string;

  quote(params: {
    subject: VerifiedSubject;
    corridor: Corridor;
    sourceAmount: string;
    sourceToken: string;
  }): Promise<PayoutQuote>;

  /** Tokenise a beneficiary. The only method that ever sees account details. */
  createDestination(params: {
    subject: VerifiedSubject;
    corridor: Corridor;
    fields: Readonly<Record<string, string>>;
  }): Promise<PayoutDestinationRef>;

  /**
   * Ask the provider to pay.
   *
   * `idempotencyKey` is derived (`${provider}:${quoteId}`), never supplied by a
   * client, so a retry of the same payout is the same key by construction.
   */
  createPayout(params: {
    subject: VerifiedSubject;
    quoteId: string;
    destinationRef: string;
    idempotencyKey: string;
  }): Promise<PayoutSubmission>;

  /**
   * Look a submission up by the key it was sent with.
   *
   * The recovery path for every indeterminate submit, and the reason a timeout
   * never has to become a resend. Returns null only when the provider states it
   * holds no record.
   */
  getPayoutByKey(idempotencyKey: string): Promise<PayoutSubmission | null>;
}

/* -------------------------------------------------------------------- card */

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
   * cardholder. PCI scope stays with the provider; we only ever hold a link,
   * and never cache it.
   */
  detailsUrl?: string;
}

export interface CardProvider {
  readonly name: string;
  readonly brand: 'visa' | 'mastercard';

  issueCard(params: { subject: VerifiedSubject }): Promise<IssuedCard>;
  getCard(providerRef: string): Promise<IssuedCard>;
}
