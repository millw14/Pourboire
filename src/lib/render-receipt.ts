import 'server-only';
import { baseUrl } from './env';
import { receiptQuery, type ReceiptParams } from './receipt';

/**
 * Fetch a rendered receipt card as PNG bytes, for attaching to a tweet.
 *
 * Goes through the public image route rather than importing `ImageResponse`
 * here, so the bytes Twitter serves and the bytes anyone loading the card URL
 * sees are produced by exactly one code path. The signature in the query string
 * is what stops that route being an open forgery generator.
 *
 * Returns null on any failure — a missing picture must never cost someone the
 * reply that tells them they were paid.
 */
export async function renderReceipt(params: ReceiptParams): Promise<Buffer | null> {
  try {
    const url = `${baseUrl()}/api/og/tip?${receiptQuery(params)}`;
    const res = await fetch(url, {
      // The card is deterministic for a given signature; no need to revalidate.
      cache: 'force-cache',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error('[receipt] render returned', res.status);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.error('[receipt] render failed', (e as Error)?.message);
    return null;
  }
}
