/**
 * Whether the scripted sandbox provider is allowed to exist.
 *
 * Pure and separate from the provider itself so it can be tested across every
 * combination rather than the one the test process happens to run under. The
 * provider imports `server-only`, which the node test runner cannot load; this
 * is the decision that actually matters, and it is testable.
 *
 * A fake provider that reports fake payouts is the most dangerous thing in this
 * directory. It is indistinguishable from a working one right up until someone
 * asks where their money went, so the rule is deliberately blunt: not in
 * production, and never against mainnet, with no override.
 */

export interface SandboxEnvironment {
  production: boolean;
  cluster: 'mainnet' | 'testnet';
}

export function sandboxAllowed(env: SandboxEnvironment): boolean {
  return !env.production && env.cluster !== 'mainnet';
}

export function assertSandboxAllowed(env: SandboxEnvironment): void {
  if (!sandboxAllowed(env)) {
    // Refusing to exist beats refusing each call: a provider that throws only
    // when used can still be listed as available, and the dashboard would then
    // say payouts work.
    throw new Error(
      'SandboxProvider must never be constructed in production or against mainnet.'
    );
  }
}
