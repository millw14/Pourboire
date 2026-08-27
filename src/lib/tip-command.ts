/**
 * The one definition of what a Pourboire command looks like.
 *
 * Imported by both the poller and the marketing pages, because they had drifted:
 * the tutorial taught `@Pourboire tip 0.5 SOL` while the parser required
 * `@pourboireonsol tip 0.5 sol @someone`. Neither the handle nor the shape
 * matched, so every command copied off the homepage was silently ignored.
 */

// Explicit extension: this module is imported directly by the Node test runner,
// which does not resolve extensionless relative paths.
import { TIPPABLE_SYMBOLS } from './tokens.ts';

export const BOT_HANDLE = '@Pourboireonsol';

export interface TipCommand {
  kind: 'tip';
  amount: string;
  /** A known symbol (`SOL`, `BONK`) or a raw mint address. */
  token: string;
  /**
   * Explicit recipient, when the command names one. Null means "the author of
   * the post this replies to" — the flow the homepage teaches.
   */
  recipientHandle: string | null;
  /** `tip 1 SOL each @a @b @c` pays every handle; `split` divides one amount. */
  mode: 'single' | 'each' | 'split';
  /** Populated for multi-recipient commands. */
  recipients: string[];
}

export interface GiveawayCommand {
  kind: 'giveaway';
  amount: string;
  token: string;
  /** How many winners are drawn. */
  winners: number;
  /** Entry window in minutes. */
  durationMinutes: number;
}

/**
 * A question rather than an instruction. These move no money, so they are the
 * one command class safe to expose to anyone who can type a mention — and the
 * reason the bot is worth tagging when you are not sending anything.
 */
export interface InfoCommand {
  kind: 'info';
  topic: 'wallet' | 'stats' | 'help';
  /**
   * Whose wallet or stats are being asked for. Null means the asker's own, or
   * the author of the post being replied to.
   */
  subject: string | null;
}

export type Command = TipCommand | GiveawayCommand | InfoCommand;

const HANDLE = '[A-Za-z0-9_]{1,15}';
const AMOUNT = '\\d[\\d,]*(?:\\.\\d+)?';
/** Base58, 32-44 chars — a raw mint address. */
const MINT = '[1-9A-HJ-NP-Za-km-z]{32,44}';
const TOKEN = `(?:${TIPPABLE_SYMBOLS.join('|')}|${MINT})`;

/** Also matches the shorter `@Pourboire`, which the tutorial taught for months. */
const BOT = '@pourboire(?:onsol)?';

const strip = (value: string) => value.replace(/,/g, '');
const normalise = (handle: string) => `@${handle.replace(/^@/, '').toLowerCase()}`;
const isBot = (handle: string) => /^@pourboire(onsol)?$/i.test(handle);

/**
 * `@Pourboireonsol giveaway 5 SOL to 10 in 2h`
 * `@Pourboireonsol giveaway 5 SOL to 10 people in 30m`
 */
const GIVEAWAY_RE = new RegExp(
  `${BOT}\\s+giveaway\\s+(${AMOUNT})\\s*(${TOKEN})?\\s+(?:to\\s+)?(\\d{1,3})\\s*(?:people|winners?)?\\s+(?:in|over)\\s+(\\d{1,4})\\s*(m|min|mins|minutes|h|hr|hrs|hours|d|days?)\\b`,
  'i'
);

function parseGiveaway(text: string): GiveawayCommand | null {
  const m = text.match(GIVEAWAY_RE);
  if (!m) return null;

  const amount = strip(m[1]!);
  const token = (m[2] ?? 'SOL').toUpperCase();
  const winners = Number(m[3]);
  const quantity = Number(m[4]);
  const unit = m[5]!.toLowerCase();

  if (!Number.isFinite(winners) || winners < 1 || winners > 100) return null;

  const perUnit = unit.startsWith('d') ? 1440 : unit.startsWith('h') ? 60 : 1;
  const durationMinutes = quantity * perUnit;

  // One minute is too short to collect entries; a week is long enough that the
  // sender's balance has probably moved on.
  if (durationMinutes < 5 || durationMinutes > 7 * 1440) return null;

  return {
    kind: 'giveaway',
    amount,
    token: TIPPABLE_SYMBOLS.includes(token) ? token : m[2] ?? 'SOL',
    winners,
    durationMinutes,
  };
}

/** `@Pourboireonsol tip 1 SOL each @a @b` / `... split 3 SOL @a @b @c` */
const MULTI_RE = new RegExp(
  `${BOT}\\s+(?:tip\\s+)?(each|split)?\\s*(${AMOUNT})\\s*(${TOKEN})?\\s+(each\\s+)?((?:@${HANDLE}[\\s,]*){2,})`,
  'i'
);

function parseMulti(text: string): TipCommand | null {
  const m = text.match(MULTI_RE);
  if (!m) return null;

  const explicitMode = (m[1] ?? m[4] ?? '').trim().toLowerCase();
  const recipients = [...(m[5] ?? '').matchAll(new RegExp(`@(${HANDLE})`, 'g'))]
    .map((r) => normalise(r[1]!))
    .filter((h) => !isBot(h));

  const unique = [...new Set(recipients)];
  if (unique.length < 2) return null;

  return {
    kind: 'tip',
    amount: strip(m[2]!),
    token: (m[3] ?? 'SOL').toUpperCase() === m[3]?.toUpperCase() ? (m[3] ?? 'SOL') : 'SOL',
    recipientHandle: null,
    mode: explicitMode === 'split' ? 'split' : 'each',
    recipients: unique,
  };
}

const SINGLE_PATTERNS: Array<{ re: RegExp; amount: number; token: number; recipient: number }> = [
  // amount, optional token, then recipient
  {
    re: new RegExp(`${BOT}\\s+tip\\s+(${AMOUNT})\\s*(${TOKEN})?\\s+@(${HANDLE})`, 'i'),
    amount: 1,
    token: 2,
    recipient: 3,
  },
  // recipient, then amount and optional token
  {
    re: new RegExp(`${BOT}\\s+tip\\s+@(${HANDLE})\\s+(${AMOUNT})\\s*(${TOKEN})?`, 'i'),
    amount: 2,
    token: 3,
    recipient: 1,
  },
  // amount and optional token, no recipient — the reply-target form
  {
    re: new RegExp(`${BOT}\\s+tip\\s+(${AMOUNT})\\s*(${TOKEN})?(?![\\w.])`, 'i'),
    amount: 1,
    token: 2,
    recipient: -1,
  },
];

function parseSingle(text: string): TipCommand | null {
  for (const pattern of SINGLE_PATTERNS) {
    const m = text.match(pattern.re);
    if (!m) continue;

    const amount = strip(m[pattern.amount]!);
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) continue;

    const rawToken = pattern.token > 0 ? m[pattern.token] : undefined;
    const rawRecipient = pattern.recipient > 0 ? m[pattern.recipient] : undefined;
    const recipientHandle = rawRecipient ? normalise(rawRecipient) : null;

    // Tipping the bot itself is always a mistake.
    if (recipientHandle && isBot(recipientHandle)) continue;

    return {
      kind: 'tip',
      amount,
      // Symbols normalise to upper case; a raw mint address keeps its casing,
      // because base58 is case-sensitive and upper-casing it breaks the address.
      token: rawToken
        ? TIPPABLE_SYMBOLS.includes(rawToken.toUpperCase())
          ? rawToken.toUpperCase()
          : rawToken
        : 'SOL',
      recipientHandle,
      mode: 'single',
      recipients: recipientHandle ? [recipientHandle] : [],
    };
  }
  return null;
}

/**
 * `@Pourboireonsol wallet` / `... wallet @alice` / `... address`
 * `@Pourboireonsol stats` / `... stats @alice`
 * `@Pourboireonsol help` / `... commands`
 *
 * Deliberately absent: `balance`. An address is already public, but a balance
 * is not, and answering in-thread would publish it permanently to everyone who
 * reads the tweet. That one stays behind the dashboard.
 */
const INFO_RE = new RegExp(
  `${BOT}\\s+(wallet|address|stats|received|help|commands)\\b\\s*(?:@(${HANDLE}))?`,
  'i'
);

const INFO_TOPICS: Record<string, InfoCommand['topic']> = {
  wallet: 'wallet',
  address: 'wallet',
  stats: 'stats',
  received: 'stats',
  help: 'help',
  commands: 'help',
};

function parseInfo(text: string): InfoCommand | null {
  const m = text.match(INFO_RE);
  if (!m) return null;

  const topic = INFO_TOPICS[m[1]!.toLowerCase()];
  if (!topic) return null;

  const rawSubject = m[2];
  const subject = rawSubject ? normalise(rawSubject) : null;

  return {
    kind: 'info',
    topic,
    // Asking for the bot's own wallet is a mistake worth ignoring rather than
    // answering with an address people might tip into by accident.
    subject: subject && isBot(subject) ? null : subject,
  };
}

export function parseCommand(text: string): Command | null {
  // Order matters. Giveaway is the most specific shape and "giveaway 5 SOL to
  // 10" would otherwise read as a tip. Info goes before the tip patterns for
  // the same reason: those verbs carry no amount, so nothing else can match
  // them, but checking first avoids relying on that.
  return parseGiveaway(text) ?? parseInfo(text) ?? parseMulti(text) ?? parseSingle(text);
}

/** Back-compatible helper for callers that only care about tips. */
export function parseTipCommand(text: string): TipCommand | null {
  const parsed = parseCommand(text);
  return parsed?.kind === 'tip' ? parsed : null;
}

/** The canonical examples shown in the UI, generated from the same rules. */
export function exampleCommand(amount = 0.5): string {
  return `${BOT_HANDLE} tip ${amount} SOL`;
}

export function exampleGiveaway(): string {
  return `${BOT_HANDLE} giveaway 5 SOL to 10 in 2h`;
}
