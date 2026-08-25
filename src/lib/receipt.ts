import { createHmac, timingSafeEqual } from 'node:crypto';
import { encryptionKey } from './env';

/**
 * Signed parameters for the receipt image.
 *
 * The image route has to be publicly reachable — Twitter and anyone viewing the
 * tweet must be able to load it. Without a signature it would be an open
 * generator for authentic-looking Pourboire receipts showing any amount between
 * any two handles, which is a ready-made scam tool. Every parameter set is
 * therefore signed, and the route renders nothing it did not itself authorise.
 */

export interface ReceiptParams {
  from: string;
  to: string;
  /** Pre-formatted, e.g. "1.5 SOL". */
  amount: string;
  /** Accent colour for the token. */
  color: string;
  /** Transaction signature, truncated for display. */
  tx?: string;
  kind: 'tip' | 'giveaway';
  /** Winner count, for giveaway cards. */
  winners?: number;
  /**
   * Rendered along the bottom of the card, typically a verification address.
   *
   * This is how a URL reaches the reader without X billing the post as a link:
   * text inside an image is not parsed, so the card can show
   * `pourboire.tips/giveaway/…` while the tweet itself stays at the plain-post
   * rate.
   */
  footer?: string;
}

const FIELD_ORDER: Array<keyof ReceiptParams> = [
  'kind',
  'from',
  'to',
  'amount',
  'color',
  'tx',
  'winners',
  'footer',
];

function canonical(params: ReceiptParams): string {
  return FIELD_ORDER.map((k) => `${k}=${params[k] ?? ''}`).join('&');
}

function sign(params: ReceiptParams): string {
  // Reuses ENCRYPTION_KEY rather than adding another secret to configure. It is
  // only ever used here to prove *we* generated a card; no key material is
  // exposed by the signature.
  return createHmac('sha256', encryptionKey()).update(canonical(params)).digest('hex').slice(0, 32);
}

/** Build the query string for a receipt image, including its signature. */
export function receiptQuery(params: ReceiptParams): string {
  const query = new URLSearchParams();
  for (const key of FIELD_ORDER) {
    const value = params[key];
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  query.set('sig', sign(params));
  return query.toString();
}

/**
 * Validate an incoming request's parameters.
 * Returns null when the signature is absent or wrong.
 */
export function verifyReceipt(search: URLSearchParams): ReceiptParams | null {
  const presented = search.get('sig');
  if (!presented) return null;

  const winnersRaw = search.get('winners');
  const params: ReceiptParams = {
    kind: search.get('kind') === 'giveaway' ? 'giveaway' : 'tip',
    from: search.get('from') ?? '',
    to: search.get('to') ?? '',
    amount: search.get('amount') ?? '',
    color: search.get('color') ?? '#14F195',
    tx: search.get('tx') ?? undefined,
    winners: winnersRaw ? Number(winnersRaw) : undefined,
    footer: search.get('footer') ?? undefined,
  };

  const expected = sign(params);
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return params;
}
