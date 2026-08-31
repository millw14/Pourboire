'use client';

import { useMemo, useState } from 'react';
import { useWallets } from '@privy-io/react-auth';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { useApi, ApiError } from '@/lib/use-api';
import type { Balance, WithdrawResponse } from './types';

/**
 * Withdraw from the custodial tip wallet.
 *
 * The version this replaces enabled its submit button on any two non-empty
 * strings, sent them, and then reported the result — success or failure — to
 * `console.log`. From the user's side the dialog just closed, or didn't.
 */


interface WithdrawDialogProps {
  onClose: () => void;
  balances: Balance[];
  onWithdrawn: () => void;
}

export function WithdrawDialog({ onClose, balances, onWithdrawn }: WithdrawDialogProps) {
  const api = useApi();
  const { toast } = useToast();
  const { wallets } = useWallets();
  const connectedWallet = wallets[0] ?? null;

  const sendable = balances.filter((b) => BigInt(b.raw) > 0n);
  const [symbol, setSymbol] = useState(sendable[0]?.symbol ?? 'USDG');
  const selected = sendable.find((b) => b.symbol === symbol) ?? null;
  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState({ amount: false, address: false });



  const amountError = useMemo(() => {
    if (!amount.trim()) return 'Enter an amount';
    const n = Number(amount);
    if (!Number.isFinite(n)) return 'That is not a number';
    if (n <= 0) return 'Amount must be greater than zero';
    return null;
  }, [amount]);

  const addressError = useMemo(() => {
    const value = address.trim();
    if (!value) return 'Enter a destination address';
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      return 'That is not a valid Robinhood Chain address';
    }
    return null;
  }, [address]);

  const canSubmit = !amountError && !addressError && !submitting && selected !== null;

  const submit = async () => {
    if (!canSubmit) {
      setTouched({ amount: true, address: true });
      return;
    }
    setSubmitting(true);
    try {
      const res = await api<WithdrawResponse>('/api/wallet/withdraw', {
        method: 'POST',
        body: JSON.stringify({ amount, token: symbol, toAddress: address.trim() }),
      });

      if (res.status === 'unconfirmed') {
        toast({
          tone: 'pending',
          title: 'Sent, awaiting confirmation',
          description:
            res.message ?? 'The network has not confirmed it yet. Do not send again — track it below.',
          action: { label: 'View on explorer', href: res.explorerUrl },
        });
      } else {
        toast({
          tone: 'success',
          title: `Sent ${res.amount}`,
          description: `To ${address.trim()}`,
          action: { label: 'View on explorer', href: res.explorerUrl },
        });
      }

      onWithdrawn();
      onClose();
    } catch (e) {
      toast({
        tone: 'error',
        title: 'Withdrawal failed',
        description: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      busy={submitting}
      title="Withdraw"
      description="Move funds out of your tip wallet to any Robinhood Chain address."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <label className="block">
          <span className="mb-1.5 block text-sm font-light text-white/70">Token</span>
          <select
            value={symbol}
            onChange={(e) => {
              setSymbol(e.target.value);
              setAmount('');
            }}
            disabled={submitting || sendable.length === 0}
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm outline-none transition focus:border-white/30 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
          >
            {sendable.length === 0 ? (
              <option className="bg-neutral-900">Nothing to withdraw</option>
            ) : (
              sendable.map((b) => (
                <option key={b.symbol} value={b.symbol} className="bg-neutral-900">
                  {b.amount}
                </option>
              ))
            )}
          </select>
        </label>

        <Field
          label="Amount"
          suffix={symbol}
          error={touched.amount ? amountError : null}
          hint={selected ? `${selected.amount} available` : undefined}
          action={
            selected ? (
              <button
                type="button"
                onClick={() => {
                  // For a token, the whole balance is sendable — gas comes out of
                  // ETH separately. For ETH itself the server keeps a reserve
                  // back, so it refuses anything that would strand the account;
                  // offering the raw balance here would just bounce.
                  const [value] = selected.amount.split(' ');
                  setAmount(selected.isGas ? '' : (value ?? '').replace(/,/g, ''));
                  setTouched((t) => ({ ...t, amount: true }));
                }}
                disabled={selected.isGas}
                title={selected.isGas ? 'Leave some ETH behind to pay gas' : undefined}
                className="rounded text-xs font-light text-blue-300 hover:text-blue-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-40"
              >
                Max
              </button>
            ) : null
          }
        >
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, amount: true }))}
            disabled={submitting}
            inputMode="decimal"
            placeholder="0.5"
            aria-invalid={touched.amount && Boolean(amountError)}
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 pr-14 text-base tabular-nums outline-none transition focus:border-white/30 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
          />
        </Field>

        <Field
          label="Destination address"
          error={touched.address ? addressError : null}
          action={
            connectedWallet ? (
              <button
                type="button"
                onClick={() => {
                  setAddress(connectedWallet.address);
                  setTouched((t) => ({ ...t, address: true }));
                }}
                disabled={submitting}
                className="rounded text-xs font-light text-blue-300 hover:text-blue-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                Use connected wallet
              </button>
            ) : null
          }
        >
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, address: true }))}
            disabled={submitting}
            spellCheck={false}
            autoComplete="off"
            placeholder="0x…"
            aria-invalid={touched.address && Boolean(addressError)}
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 font-mono text-sm outline-none transition focus:border-white/30 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
          />
        </Field>

        <p className="rounded-lg bg-white/5 px-3 py-2 text-xs font-light leading-relaxed text-white/50">
          Transfers cannot be reversed. Check the address before you send.
        </p>

        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="flex-1 rounded-lg bg-white/10 px-4 py-2.5 text-sm font-light transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="flex-1 rounded-lg bg-blue-500 px-4 py-2.5 text-sm font-light transition hover:bg-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? 'Sending…' : 'Withdraw'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({
  label,
  hint,
  error,
  suffix,
  action,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  suffix?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-sm font-light text-white/70">{label}</span>
        {action}
      </span>
      <span className="relative block">
        {children}
        {suffix && (
          <span
            aria-hidden
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-light text-white/40"
          >
            {suffix}
          </span>
        )}
      </span>
      {error ? (
        <span role="alert" className="mt-1.5 block text-xs font-light text-red-300">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1.5 block text-xs font-light text-white/40">{hint}</span>
      ) : null}
    </label>
  );
}
