'use client';

import { useMemo, useState } from 'react';
import { useWallets, useSendTransaction } from '@privy-io/react-auth';
import { encodeFunctionData, parseAbi } from 'viem';
import { Modal } from '@/components/ui/modal';
import { CopyButton } from '@/components/ui/copy-button';
import { QrCode } from '@/components/ui/qr-code';
import { useToast } from '@/components/ui/toast';
import { KNOWN_TOKENS, DEFAULT_TOKEN, toBaseUnits, isNative } from '@/lib/tokens';

/**
 * Add funds to the custodial tip wallet.
 *
 * Two ways in: send from a wallet Privy has connected, or copy/scan the address.
 * Every outcome is reported to the user — the version this replaces logged its
 * failure branches to the console and left the dialog sitting open with no
 * explanation.
 */

const ERC20_TRANSFER = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);

/** Only the currencies make sense to top up with; equities are tipped, not funded. */
const FUNDABLE = KNOWN_TOKENS.filter((t) => t.kind === 'stable' || t.kind === 'native');

interface FundDialogProps {
  onClose: () => void;
  address: string;
  onFunded: () => void;
}

/** Mounted only while open, so its state starts fresh each time. */
export function FundDialog({ onClose, address, onFunded }: FundDialogProps) {
  const { wallets } = useWallets();
  const { sendTransaction } = useSendTransaction();
  const { toast } = useToast();

  const [amount, setAmount] = useState('');
  const [symbol, setSymbol] = useState(DEFAULT_TOKEN.symbol);
  const [sending, setSending] = useState(false);

  const wallet = wallets[0] ?? null;
  const token = FUNDABLE.find((t) => t.symbol === symbol) ?? DEFAULT_TOKEN;

  // EIP-681. Wallet apps read this straight into a send screen; plain scanners
  // still show the address.
  const paymentUri = useMemo(() => {
    if (isNative(token)) return `ethereum:${address}@4663`;
    return `ethereum:${token.address}@4663/transfer?address=${address}`;
  }, [address, token]);

  const amountError = useMemo(() => {
    if (!amount.trim()) return null;
    try {
      const base = toBaseUnits(amount, token.decimals);
      if (base <= 0n) return 'Enter an amount greater than zero';
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, [amount, token]);

  const canSend = Boolean(wallet) && !amountError && amount.trim() !== '' && !sending;

  const send = async () => {
    if (!canSend || !wallet) return;
    setSending(true);
    try {
      const base = toBaseUnits(amount, token.decimals);

      const request = isNative(token)
        ? { to: address as `0x${string}`, value: base }
        : {
            to: token.address!,
            data: encodeFunctionData({
              abi: ERC20_TRANSFER,
              functionName: 'transfer',
              args: [address as `0x${string}`, base],
            }),
          };

      const { hash } = await sendTransaction(request, { address: wallet.address });

      toast({
        tone: 'success',
        title: `Sent ${amount} ${token.symbol}`,
        description: 'Your tip wallet balance will update shortly.',
        action: { label: 'View on explorer', href: explorerUrl(hash) },
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
      onClose={onClose}
      open
      busy={sending}
      title="Add funds"
      description="Top up your tip wallet so you can send tips on X."
    >
      <div className="space-y-5">
        <div className="flex flex-col items-center gap-3 rounded-xl bg-white/5 p-4">
          <QrCode value={paymentUri} label={`QR code for tip wallet address ${address}`} />
          <CopyButton
            value={address}
            describe="tip wallet address"
            className="bg-black/40 px-3 py-2"
          />
          <p className="text-center text-xs font-light leading-relaxed text-white/40">
            Send USDG or ETH on Robinhood Chain to this address.
          </p>
        </div>

        <div className="space-y-3 border-t border-white/10 pt-5">
          <p className="text-sm font-light text-white/70">
            {wallet ? 'Or send from your connected wallet' : 'Connect a wallet to send directly'}
          </p>

          <div className="flex gap-2">
            <label className="flex-1">
              <span className="sr-only">Amount</span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={sending}
                inputMode="decimal"
                placeholder="10"
                aria-invalid={Boolean(amountError)}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-base tabular-nums outline-none transition focus:border-white/30 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
              />
            </label>
            <label>
              <span className="sr-only">Token</span>
              <select
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                disabled={sending}
                className="h-full rounded-lg border border-white/10 bg-black/40 px-3 py-2.5 text-sm outline-none transition focus:border-white/30 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50"
              >
                {FUNDABLE.map((t) => (
                  <option key={t.symbol} value={t.symbol} className="bg-neutral-900">
                    {t.symbol}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {amountError && (
            <p role="alert" className="text-xs font-light text-red-300">
              {amountError}
            </p>
          )}

          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            className="h-11 w-full rounded-lg bg-[#00C805] px-4 text-sm font-medium text-black transition hover:bg-[#00B004] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sending ? 'Sending…' : wallet ? `Send ${token.symbol}` : 'No wallet connected'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function explorerUrl(hash: string): string {
  return `https://robinhoodchain.blockscout.com/tx/${hash}`;
}

/** Turn the common wallet failures into something a person can act on. */
function describeError(e: unknown): string {
  const message = (e as Error)?.message ?? String(e);
  const lower = message.toLowerCase();

  if (lower.includes('rejected') || lower.includes('denied') || lower.includes('cancel')) {
    return 'You cancelled the transaction in your wallet.';
  }
  if (lower.includes('insufficient')) {
    return 'That wallet does not have enough to cover the amount plus gas.';
  }
  if (lower.includes('chain') || lower.includes('network')) {
    return 'Your wallet is on the wrong network — switch it to Robinhood Chain and try again.';
  }
  return message;
}
