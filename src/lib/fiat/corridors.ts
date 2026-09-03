/**
 * A corridor is a destination for money: a country, a way of getting it there,
 * and the currency it arrives in.
 *
 * Pure, and deliberately a separate concept from the display currencies in
 * `./currencies`. Those are for showing someone what a balance is worth locally
 * and can be added freely. A corridor is a claim that we can actually pay
 * someone in that country by that method — a claim only a contracted provider
 * can make good on. Conflating them means adding a currency to a dropdown
 * silently advertises a payout route that does not exist.
 */

export type PayoutMethod =
  | 'bank'
  | 'mobile_money'
  /** Brazil. */
  | 'pix'
  /** Mexico. */
  | 'spei'
  /** Canada. */
  | 'interac'
  /** India. */
  | 'upi'
  /** Push-to-card, where local rails are absent. */
  | 'card_push';

export const PAYOUT_METHODS: readonly PayoutMethod[] = [
  'bank',
  'mobile_money',
  'pix',
  'spei',
  'interac',
  'upi',
  'card_push',
];

export interface Corridor {
  /** ISO 3166-1 alpha-2, uppercase. */
  country: string;
  method: PayoutMethod;
  /** ISO 4217, uppercase. A plain string: payout currencies are not display currencies. */
  currency: string;
}

/**
 * The canonical string form, e.g. `NG:bank:NGN`.
 *
 * One key format everywhere — database rows, capability tables, log lines — so
 * a corridor in a stored payout can be compared to one in a routing table
 * without a normalisation step someone can forget.
 */
export function corridorKey(c: Corridor): string {
  return `${c.country.toUpperCase()}:${c.method}:${c.currency.toUpperCase()}`;
}

export function parseCorridorKey(key: string): Corridor | null {
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  const [country, method, currency] = parts as [string, string, string];

  const corridor: Corridor = {
    country: country.toUpperCase(),
    method: method as PayoutMethod,
    currency: currency.toUpperCase(),
  };
  return isWellFormed(corridor) ? corridor : null;
}

export function isWellFormed(c: Corridor): boolean {
  return (
    /^[A-Z]{2}$/.test(c.country) &&
    /^[A-Z]{3}$/.test(c.currency) &&
    PAYOUT_METHODS.includes(c.method)
  );
}

/** How a method is described to someone choosing one. */
export const METHOD_LABELS: Readonly<Record<PayoutMethod, string>> = {
  bank: 'Bank transfer',
  mobile_money: 'Mobile money',
  pix: 'Pix',
  spei: 'SPEI',
  interac: 'Interac',
  upi: 'UPI',
  card_push: 'To a debit card',
};
