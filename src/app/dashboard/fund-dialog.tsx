'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { Modal } from '@/components/ui/modal';
import { CopyButton } from '@/components/ui/copy-button';
import { QrCode } from '@/components/ui/qr-code';
import { useToast } from '@/components/ui/toast';
import { rpcUrl, cluster } from '@/lib/env';

/**
 * Add SOL to the custodial tip wallet.
 *
 * Two ways in: send from a connected browser wallet, or copy/scan the address.
 * Every outcome is reported to the user — the previous version logged its
 * 403-from-RPC and insufficient-funds branches to the console and left the
 * dialog sitting open with no explanation.
 */

const WalletMultiButton = dynamic(
  () => import('@solana/wallet-adapter-react-ui').then((m) => m.WalletMultiButton),
  { ssr: false, loading: () => <div className="h-11 animate-pulse rounded-lg bg-white/10" /> }
);

interface FundDialogProps {
  onClose: () => void;
  address: string;
  onFunded: () => void;
}

/** Mounted only while open, so its state starts fresh each time. */
export function FundDialog({ onClose, address, onFunded }: FundDialogProps) {
  const { publicKey, sendTransaction, connected } = useWallet();
  const { toast } = useToast();
  const [amount, setAmount] = useState('');
  const [sending, setSending] = useState(false);

  const solanaUri = useMemo(() => {
    const params = new URLSearchParams({ label: 'Pourboire' });
    const n = Number(amount);
    if (Number.isFinite(n) && n > 0) params.set('amount', String(n));
    return `solana:${address}?${params.toString()}`;
  }, [address, amount]);

  const amountError = useMemo(() => {
    if (!amount.trim()) return null;
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return 'Enter a valid amount';
    return null;
  }, [amount]);

  const canSend = connected && !amountError && Number(amount) > 0 && !sending;

  const send = async () => {
    if (!canSend || !publicKey || !sendTransaction) return;
    setSending(true);
    try {
      const conn = new Connection(rpcUrl(), 'confirmed');
      const lamports = Math.round(Number(amount) * LAMPORTS_PER_SOL);

      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      const tx = new Transaction({
        feePayer: publicKey,
        blockhash,
        lastValidBlockHeight,
      }).add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: new PublicKey(address),
          lamports,
        })
      );

      const signature = await sendTransaction(tx, conn);

      // Confirm against the blockhash's validity window. The old code retried the
      // whole transfer on timeout, which could send the amount a second time.
      const result = await conn.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      if (result.value.err) {
        toast({
          tone: 'error',
          title: 'Transfer failed',
          description: 'The network rejected the transaction. Nothing was sent.',
        });
        return;
      }

      toast({
        tone: 'success',
        title: `Added ${amount} SOL`,
        description: 'Your tip wallet balance will update shortly.',
        action: { label: 'View on Solscan', href: explorerUrl(signature) },
      });
      onFunded();
      onClose();
    } catch (e) {
      toast({ tone: 'error', title: 'Transfer failed', description: describeError(e) });
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      busy={sending}
      title="Add funds"
      description="Top up your tip wallet so you can send tips on X."
    >
      <div className="space-y-5">
        <div className="flex flex-col items-center gap-3 rounded-xl bg-white/5 p-4">
          <QrCode value={solanaUri} label={`QR code for tip wallet address ${address}`} />
          <CopyButton
            value={address}
            describe="tip wallet address"
            className="bg-black/40 px-3 py-2"
          />
          <p className="text-center text-xs font-light leading-relaxed text-white/40">
            Send SOL to this address from any wallet or exchange.
          </p>
        </div>

        <div className="space-y-3 border-t border-white/10 pt-5">
          <p className="text-sm font-light text-white/70">Or send from a connected wallet</p>

          <label className="block">
            <span className="sr-only">Amount in SOL</span>
            <span className="relative block">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={sending}
                inputMode="decimal"
                placeholder="0.5"
                aria-invalid={Boolean(amountError)}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 pr-14 text-base tabular-nums outline-none transition focus:border-white/30 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-light text-white/40"
              >
                SOL
              </span>
            </span>
            {amountError && (
              <span role="alert" className="mt-1.5 block text-xs font-light text-red-300">
                {amountError}
              </span>
            )}
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <WalletMultiButton className="!h-11 !w-full !justify-center !rounded-lg !bg-purple-600 !text-sm !font-light hover:!bg-purple-700" />
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              className="h-11 rounded-lg bg-blue-500 px-4 text-sm font-light transition hover:bg-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {sending ? 'Sending…' : connected ? 'Send' : 'Connect first'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function explorerUrl(signature: string): string {
  const c = cluster();
  const suffix = c === 'mainnet-beta' ? '' : `?cluster=${c === 'devnet' ? 'devnet' : 'testnet'}`;
  return `https://solscan.io/tx/${signature}${suffix}`;
}

/** Turn the common wallet/RPC failures into something a person can act on. */
function describeError(e: unknown): string {
  const message = (e as Error)?.message ?? String(e);
  const lower = message.toLowerCase();

  if (lower.includes('user rejected') || lower.includes('declined')) {
    return 'You cancelled the transaction in your wallet.';
  }
  if (lower.includes('403') || lower.includes('forbidden')) {
    return 'The Solana RPC refused the request. The app needs a provider RPC URL configured.';
  }
  if (lower.includes('insufficient') || lower.includes('debit')) {
    return 'Your connected wallet does not have enough SOL to cover the amount plus the network fee.';
  }
  if (lower.includes('blockhash') || lower.includes('expired')) {
    return 'The transaction expired before it was confirmed. Nothing was sent — try again.';
  }
  return message;
}
