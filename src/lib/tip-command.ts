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
import { TIPPABLE_SYMBOLS, DEFAULT_TOKEN } from './tokens.ts';

export const BOT_HANDLE = '@Pourboireonsol';

export interface TipCommand {
  kind: 'tip';
  amount: string;
  /** A known symbol (`USDG`, `NVDA`) or a raw contract address. */
  token: string;
  /**
   * Explicit recipient, when the command names one. Null means "the author of
   * the post this replies to" — the flow the homepage teaches.
   */
  recipientHandle: string | null;
  /** `tip 1 USDG each @a @b @c` pays every handle; `split` divides one amount. */
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

/**
 * Split an amount between people who replied to the post, without naming them.
 *
 * This is `split` with the recipient list discovered instead of typed. It is
 * kept as its own shape because the discovery has a cost the other commands do
 * not: reading a thread is $0.005 per post plus $0.010 per unique author, so the
 * recipient count is bounded and always explicit in the reply.
 */
export interface RainCommand {
  kind: 'rain';
  amount: string;
  token: string;
  /** Upper bound on recipients. Capped by RAIN_MAX_RECIPIENTS at settlement. */
  maxRecipients: number;
}

/**
 * Repeat the tip in the post being replied to, to the same person.
 *
 * Resolved from our own ledger rather than by re-reading the parent tweet, so
 * it costs nothing extra in API spend.
 */
export interface MatchCommand {
  kind: 'match';
}

export type Command =
  | TipCommand
  | GiveawayCommand
  | InfoCommand
  | RainCommand
  | MatchCommand;

/** Default recipients for a bare `rain`, when no count is given. */
export const RAIN_DEFAULT_RECIPIENTS = 10;

const HANDLE = '[A-Za-z0-9_]{1,15}';
const AMOUNT = '\\d[\\d,]*(?:\\.\\d+)?';
/** A raw ERC-20 contract address. */
const MINT = '0x[0-9a-fA-F]{40}';
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
  const token = (m[2] ?? DEFAULT_TOKEN.symbol).toUpperCase();
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
    token: TIPPABLE_SYMBOLS.includes(token) ? token : m[2] ?? DEFAULT_TOKEN.symbol,
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
    token: m[3] ?? DEFAULT_TOKEN.symbol,
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
      // Symbols normalise to upper case; a raw contract address keeps its
      // casing, because EIP-55 checksums are encoded in it.
      token: rawToken
        ? TIPPABLE_SYMBOLS.includes(rawToken.toUpperCase())
          ? rawToken.toUpperCase()
          : rawToken
          : DEFAULT_TOKEN.symbol,
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

/**
 * `@Pourboireonsol rain 5 SOL`
 * `@Pourboireonsol rain 5 SOL to 20`
 * `@Pourboireonsol rain 5 SOL to 20 people`
 */
const RAIN_RE = new RegExp(
  `${BOT}\\s+rain\\s+(${AMOUNT})\\s*(${TOKEN})?(?:\\s+(?:to|on|between|among)\\s+(\\d{1,3})\\s*(?:people|repliers?|replies)?)?`,
  'i'
);

function parseRain(text: string): RainCommand | null {
  const m = text.match(RAIN_RE);
  if (!m) return null;

  const amount = strip(m[1]!);
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return null;

  const requested = m[3] ? Number(m[3]) : RAIN_DEFAULT_RECIPIENTS;
  if (!Number.isFinite(requested) || requested < 1) return null;

  const rawToken = m[2];
  return {
    kind: 'rain',
    amount,
    token: rawToken
      ? TIPPABLE_SYMBOLS.includes(rawToken.toUpperCase())
        ? rawToken.toUpperCase()
        : rawToken
      : DEFAULT_TOKEN.symbol,
    maxRecipients: requested,
  };
}

/** `@Pourboireonsol match` — nothing else to parse; the parent supplies the rest. */
const MATCH_RE = new RegExp(`${BOT}\\s+match\\b`, 'i');

function parseMatch(text: string): MatchCommand | null {
  return MATCH_RE.test(text) ? { kind: 'match' } : null;
}

export function parseCommand(text: string): Command | null {
  // Order matters, most specific first. "giveaway 5 SOL to 10" and "rain 5 SOL
  // to 20" both end in a bare number that the tip patterns would happily read as
  // a recipient count, so both are matched before them.
  return (
    parseGiveaway(text) ??
    parseRain(text) ??
    parseMatch(text) ??
    parseInfo(text) ??
    parseMulti(text) ??
    parseSingle(text)
  );
}

/** Back-compatible helper for callers that only care about tips. */
export function parseTipCommand(text: string): TipCommand | null {
  const parsed = parseCommand(text);
  return parsed?.kind === 'tip' ? parsed : null;
}

/** The canonical examples shown in the UI, generated from the same rules. */
export function exampleCommand(amount = 5): string {
  return `${BOT_HANDLE} tip ${amount} ${DEFAULT_TOKEN.symbol}`;
}

export function exampleRain(amount = 10): string {
  return `${BOT_HANDLE} rain ${amount} ${DEFAULT_TOKEN.symbol}`;
}

export function exampleGiveaway(): string {
  return `${BOT_HANDLE} giveaway 100 ${DEFAULT_TOKEN.symbol} to 10 in 2h`;
}
