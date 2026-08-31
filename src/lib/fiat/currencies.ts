/**
 * Currency data and formatting. No I/O, no secrets, safe on both sides.
 *
 * Split from `./rates` so the browser can format a local amount without pulling
 * in the server-only fetching — and so these functions are testable at all,
 * since `server-only` throws the moment a test runner imports it.
 */

export const SUPPORTED_CURRENCIES = [
  { code: 'NGN', name: 'Nigerian Naira', symbol: '₦' },
  { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh' },
  { code: 'GHS', name: 'Ghanaian Cedi', symbol: 'GH₵' },
  { code: 'ZAR', name: 'South African Rand', symbol: 'R' },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹' },
  { code: 'PHP', name: 'Philippine Peso', symbol: '₱' },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$' },
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'GBP', name: 'Pound Sterling', symbol: '£' },
  { code: 'USD', name: 'US Dollar', symbol: '$' },
] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number]['code'];

export interface Rate {
  currency: string;
  /** Units of local currency per 1 USD. */
  perUsd: number;
  /** When the source last recalculated. */
  asOf: string;
}

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return SUPPORTED_CURRENCIES.some((c) => c.code === code.toUpperCase());
}

export function currencyMeta(code: string) {
  return SUPPORTED_CURRENCIES.find((c) => c.code === code.toUpperCase()) ?? null;
}

/**
 * Format a USD amount in local currency, for display only.
 *
 * Minor units are dropped above a thousand: two decimals on a six-figure
 * indicative number reads as precision the figure does not have.
 */
export function formatLocal(usd: number, rate: Rate): string {
  const meta = currencyMeta(rate.currency);
  const value = usd * rate.perUsd;
  const wholeOnly = value >= 1000;

  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: wholeOnly ? 0 : 2,
    maximumFractionDigits: wholeOnly ? 0 : 2,
  }).format(value);

  return `${meta?.symbol ?? ''}${formatted}`;
}
