import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxAllowed, assertSandboxAllowed } from './sandbox-policy.ts';

test('the sandbox is allowed only in development against testnet', () => {
  assert.ok(sandboxAllowed({ production: false, cluster: 'testnet' }));
});

test('every other combination is refused', () => {
  // Including development-against-mainnet, which is the one someone would
  // actually reach for: pointing a local build at real money to "just check
  // something" is exactly when a fake provider does the most damage.
  assert.ok(!sandboxAllowed({ production: true, cluster: 'testnet' }));
  assert.ok(!sandboxAllowed({ production: false, cluster: 'mainnet' }));
  assert.ok(!sandboxAllowed({ production: true, cluster: 'mainnet' }));
});

test('the assertion throws rather than returning a flag', () => {
  // The provider calls this from its constructor, so a refusal means no object
  // exists to be registered, listed as available, or called.
  assert.throws(
    () => assertSandboxAllowed({ production: true, cluster: 'mainnet' }),
    /never be constructed/
  );
  assert.doesNotThrow(() => assertSandboxAllowed({ production: false, cluster: 'testnet' }));
});
