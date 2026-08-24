/**
 * The one definition of what a tip command looks like.
 *
 * This is imported by both the poller and the landing page, because they had
 * drifted: the tutorial taught `@Pourboire tip 0.5 SOL` while the parser required
 * `@pourboireonsol tip 0.5 sol @someone`. Neither the handle nor the shape
 * matched, so every command a user copied off the homepage was silently ignored.
 */

export const BOT_HANDLE = '@Pourboireonsol';

export interface TipCommand {
  amount: number;
  token: 'SOL' | 'USDC';
  /**
   * Explicit recipient, when the command names one. Null means "the author of
   * the post this is a reply to" — which is the flow the homepage actually
   * teaches and the product is named for.
   */
  recipientHandle: string | null;
}

const HANDLE = '[A-Za-z0-9_]{1,15}';
const AMOUNT = '\\d+(?:\\.\\d+)?';
const TOKEN = '(?:sol|usdc)';

/**
 * Accepted forms (case-insensitive, token optional and defaulting to SOL):
 *   @Pourboireonsol tip 0.5 SOL @alice
 *   @Pourboireonsol tip @alice 0.5 SOL
 *   @Pourboireonsol tip 0.5 SOL          <- recipient = author of the parent post
 *   @Pourboireonsol tip 0.5
 * The bot handle also matches the shorter `@Pourboire`, since that is what the
 * tutorial showed for a long time and people will have learned it.
 */
const BOT = '@pourboire(?:onsol)?';

const PATTERNS: Array<{ re: RegExp; amount: number; token: number; recipient: number }> = [
  // amount, token, then recipient
  {
    re: new RegExp(`${BOT}\\s+tip\\s+(${AMOUNT})\\s*(${TOKEN})?\\s+@(${HANDLE})`, 'i'),
    amount: 1,
    token: 2,
    recipient: 3,
  },
  // recipient, then amount and token
  {
    re: new RegExp(`${BOT}\\s+tip\\s+@(${HANDLE})\\s+(${AMOUNT})\\s*(${TOKEN})?`, 'i'),
    amount: 2,
    token: 3,
    recipient: 1,
  },
  // amount and optional token, no recipient — reply-target form
  {
    re: new RegExp(`${BOT}\\s+tip\\s+(${AMOUNT})\\s*(${TOKEN})?(?![\\w.])`, 'i'),
    amount: 1,
    token: 2,
    recipient: -1,
  },
];

export function parseTipCommand(text: string): TipCommand | null {
  for (const pattern of PATTERNS) {
    const m = text.match(pattern.re);
    if (!m) continue;

    const amount = Number(m[pattern.amount]);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const rawToken = pattern.token > 0 ? m[pattern.token] : undefined;
    const token = (rawToken?.toUpperCase() as 'SOL' | 'USDC') || 'SOL';

    const rawRecipient = pattern.recipient > 0 ? m[pattern.recipient] : undefined;
    const recipientHandle = rawRecipient ? `@${rawRecipient.toLowerCase()}` : null;

    // Tipping the bot itself is always a mistake.
    if (recipientHandle && /^@pourboire(onsol)?$/i.test(recipientHandle)) continue;

    return { amount, token, recipientHandle };
  }
  return null;
}

/** The canonical example shown in the UI, generated from the same rules. */
export function exampleCommand(amount = 0.5): string {
  return `${BOT_HANDLE} tip ${amount} SOL`;
}
