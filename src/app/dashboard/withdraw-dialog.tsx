'use client';

import { useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { useApi, ApiError } from '@/lib/use-api';
import type { WithdrawResponse } from './types';

/**
 * Withdraw from the custodial tip wallet.
 *
 * The version this replaces enabled its submit button on any two non-empty
 * strings, sent them, and then reported the result — success or failure — to
 * `console.log`. From the user's side the dialog just closed, or didn't.
 */

/** Kept in step with FEE_RESERVE + RENT_EXEMPT_RESERVE in src/lib/solana.ts. */
const RESERVE_SOL = (890_880 + 10_000) / 1_000_000_000;

interface WithdrawDialogProps {
  onClose: () => void;
  maxSol: number;
  onWithdrawn: () => void;
}

export function WithdrawDialog({ onClose, maxSol, onWithdrawn }: WithdrawDialogProps) {
  const api = useApi();
  const { toast } = useToast();
  const { publicKey, connected } = useWallet();

  const [amount, setAmount] = useState('');
  const [address, setAddress] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState({ amount: false, address: false });

  const spendable = Math.max(0, maxSol - RESERVE_SOL);

  const amountError = useMemo(() => {
    if (!amount.trim()) return 'Enter an amount';
    const n = Number(amount);
    if (!Number.isFinite(n)) return 'That is not a number';
    if (n <= 0) return 'Amount must be greater than zero';
    if (n > spendable) {
      return `You can withdraw up to ${spendable.toFixed(6)} SOL — the rest covers fees and keeps the account open`;
    }
    return null;
  }, [amount, spendable]);

  const addressError = useMemo(() => {
    if (!address.trim()) return 'Enter a destination address';
    try {
      const key = new PublicKey(address.trim());
      if (!PublicKey.isOnCurve(key.toBytes())) return 'That is a program address, not a wallet';
      return null;
    } catch {
      return 'That is not a valid Solana address';
    }
  }, [address]);

  const canSubmit = !amountError && !addressError && !submitting;

  const submit = async () => {
    if (!canSubmit) {
      setTouched({ amount: true, address: true });
      return;
    }
    setSubmitting(true);
    try {
      const res = await api<WithdrawResponse>('/api/wallet/withdraw', {
        method: 'POST',
        body: JSON.stringify({ amount, toAddress: address.trim() }),
      });

      if (res.status === 'unconfirmed') {
        toast({
          tone: 'pending',
          title: 'Sent, awaiting confirmation',
          description:
            res.message ?? 'The network has not confirmed it yet. Do not send again — track it below.',
          action: { label: 'View on Solscan', href: res.explorerUrl },
        });
      } else {
        toast({
          tone: 'success',
          title: `Sent ${res.amount} SOL`,
          description: `To ${address.trim()}`,
          action: { label: 'View on Solscan', href: res.explorerUrl },
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
      title="Withdraw SOL"
      description="Move SOL out of your tip wallet to any Solana address."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <Field
          label="Amount"
          suffix="SOL"
          error={touched.amount ? amountError : null}
          hint={`${spendable.toFixed(6)} SOL available`}
          action={
            spendable > 0 ? (
              <button
                type="button"
                onClick={() => {
                  // A real max: the balance minus the fee and rent reserve, so
                  // "everything" produces a transaction that can actually pay
                  // for itself.
                  setAmount(spendable.toFixed(6));
                  setTouched((t) => ({ ...t, amount: true }));
                }}
                className="rounded text-xs font-light text-blue-300 hover:text-blue-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
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
            connected && publicKey ? (
              <button
                type="button"
                onClick={() => {
                  setAddress(publicKey.toString());
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
            placeholder="Solana address"
            aria-invalid={touched.address && Boolean(addressError)}
            className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 font-mono text-sm outline-none transition focus:border-white/30 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
          />
        </Field>

        <p className="rounded-lg bg-white/5 px-3 py-2 text-xs font-light leading-relaxed text-white/50">
          Solana transfers cannot be reversed. Check the address before you send.
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
