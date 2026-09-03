import 'server-only';
import { cluster, isProduction } from '../env';
import { assertSandboxAllowed } from './sandbox-policy.ts';
import { ProviderError } from './types.ts';
import type {
  CardProvider,
  IdentityProvider,
  IssuedCard,
  PayoutDestinationRef,
  PayoutProvider,
  PayoutQuote,
  PayoutSubmission,
  VerificationSession,
} from './types.ts';
import type { Corridor } from './corridors.ts';
import type { VerifiedSubject } from './subject.ts';

/**
 * A provider that does nothing, scripted so every branch can be walked.
 *
 * Phase 1 ships a payout system with no payout provider, which leaves the
 * interesting paths — a submit that times out, a funding leg that never
 * confirms — unreachable and therefore untested in anything but unit form. This
 * closes that gap: `FIAT_SANDBOX_SCRIPT=quote_ok,submit_timeout,paid` walks the
 * system through exactly those states end to end.
 *
 * It **throws on construction** in production or against mainnet. A fake
 * provider that reports fake payouts is the single most dangerous thing in this
 * directory — it is indistinguishable from a working one right up until someone
 * asks where their money went. The guard is asserted by a test.
 *
 * It issues no card numbers. `last4` is `0000`, which is not a valid card
 * ending, so it cannot be mistaken for one anywhere downstream.
 */

export type SandboxStep =
  | 'quote_ok'
  | 'quote_refused'
  | 'submit_ok'
  | 'submit_pending'
  | 'submit_refused'
  /** No answer. The case that must become `submit_indeterminate`, never a resend. */
  | 'submit_timeout'
  | 'paid'
  | 'failed'
  | 'reversed'
  | 'verify_pending'
  | 'verify_ok'
  | 'verify_rejected';

export const SANDBOX_NAME = 'sandbox';

function parseScript(raw: string | undefined): SandboxStep[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as SandboxStep[];
}

export class SandboxProvider implements PayoutProvider, CardProvider, IdentityProvider {
  readonly name = SANDBOX_NAME;
  readonly brand = 'visa' as const;

  private readonly script: SandboxStep[];
  private cursor = 0;
  private readonly submissions = new Map<string, PayoutSubmission>();

  constructor(script?: string) {
    // Throws in production or against mainnet. The decision lives in a pure
    // module so it can be tested across every combination, not just the one this
    // process happens to run under.
    assertSandboxAllowed({ production: isProduction(), cluster: cluster() });
    this.script = parseScript(script ?? process.env.FIAT_SANDBOX_SCRIPT);
  }

  /** Steps are consumed in order; the last one repeats once the script runs out. */
  private step(): SandboxStep | null {
    if (this.script.length === 0) return null;
    const index = Math.min(this.cursor, this.script.length - 1);
    this.cursor += 1;
    return this.script[index]!;
  }

  private scripted(step: SandboxStep): boolean {
    return this.script.includes(step);
  }

  /* -------------------------------------------------------------- identity */

  async startVerification(params: {
    userId: string;
    handle: string;
    country?: string;
  }): Promise<VerificationSession> {
    const providerRef = `sbx_ver_${params.userId}`;
    if (this.scripted('verify_rejected')) {
      return { status: 'rejected', providerRef, reason: 'Scripted rejection.' };
    }
    if (this.scripted('verify_ok')) {
      return { status: 'verified', providerRef, country: params.country ?? 'NG' };
    }
    return { status: 'pending', providerRef, hostedUrl: 'https://example.invalid/sandbox' };
  }

  async getVerification(providerRef: string): Promise<VerificationSession> {
    if (this.scripted('verify_ok')) {
      return { status: 'verified', providerRef, country: 'NG' };
    }
    return { status: 'pending', providerRef };
  }

  /* ---------------------------------------------------------------- payout */

  async quote(params: {
    subject: VerifiedSubject;
    corridor: Corridor;
    sourceAmount: string;
    sourceToken: string;
  }): Promise<PayoutQuote> {
    if (this.step() === 'quote_refused') {
      throw new ProviderError({ definite: true, message: 'Scripted quote refusal.' });
    }
    // A flat, obviously fake rate. Nothing here should ever be read as a price.
    const rate = 1000;
    const destinationMinor = (BigInt(params.sourceAmount) * BigInt(rate)) / 1_000_000n;
    return {
      id: `sbx_q_${Date.now()}`,
      sourceAmount: params.sourceAmount,
      sourceToken: params.sourceToken,
      corridor: params.corridor,
      destinationAmount: destinationMinor.toString(),
      rate,
      fee: '0',
      expiresAt: new Date(Date.now() + 5 * 60_000),
    };
  }

  async createDestination(params: {
    subject: VerifiedSubject;
    corridor: Corridor;
    fields: Readonly<Record<string, string>>;
  }): Promise<PayoutDestinationRef> {
    const account = params.fields.accountNumber ?? '';
    return {
      ref: `sbx_dest_${params.subject.userId}_${params.corridor.country}`,
      label: `Sandbox ${params.corridor.country}`,
      last4: account.slice(-4) || undefined,
    };
  }

  async createPayout(params: {
    quoteId: string;
    destinationRef: string;
    idempotencyKey: string;
  }): Promise<PayoutSubmission> {
    // The property a real provider guarantees, reproduced here so the caller's
    // idempotency handling is exercised rather than assumed.
    const existing = this.submissions.get(params.idempotencyKey);
    if (existing) return existing;

    const step = this.step();
    if (step === 'submit_refused') {
      throw new ProviderError({ definite: true, message: 'Scripted definite refusal.' });
    }
    if (step === 'submit_timeout') {
      // Deliberately records nothing: an indeterminate submit is one where the
      // provider may or may not have accepted it, and `getPayoutByKey` is the
      // only way to find out.
      throw new ProviderError({ definite: false, message: 'Scripted timeout, no answer.' });
    }

    const submission: PayoutSubmission = {
      providerRef: `sbx_p_${params.quoteId}`,
      status: 'pending',
    };
    this.submissions.set(params.idempotencyKey, submission);
    return submission;
  }

  async getPayoutByKey(idempotencyKey: string): Promise<PayoutSubmission | null> {
    const recorded = this.submissions.get(idempotencyKey);
    if (recorded) {
      if (this.scripted('paid')) return { ...recorded, status: 'paid' };
      if (this.scripted('failed')) {
        return { ...recorded, status: 'failed', reason: 'Scripted failure.' };
      }
      return recorded;
    }
    // Null is a statement, not an absence of information: the provider holds no
    // record of this key, so submitting again is safe. It is the only path in
    // the system that permits a resubmit.
    return null;
  }

  /* ------------------------------------------------------------------ card */

  async issueCard(params: { subject: VerifiedSubject }): Promise<IssuedCard> {
    return {
      providerRef: `sbx_card_${params.subject.userId}`,
      status: 'active',
      // Not a valid card ending, so it cannot be mistaken for one.
      last4: '0000',
      brand: 'visa',
    };
  }

  async getCard(providerRef: string): Promise<IssuedCard> {
    return { providerRef, status: 'active', last4: '0000', brand: 'visa' };
  }
}
