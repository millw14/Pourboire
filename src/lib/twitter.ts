import { TwitterApi } from 'twitter-api-v2';
// Explicit extension: this module is imported by the Node test runner, which
// does not resolve extensionless relative paths.
import { twitterCredentials } from './env.ts';

let client: TwitterApi | null = null;

function getClient(): TwitterApi {
  if (!client) {
    client = new TwitterApi(twitterCredentials());
  }
  return client;
}

export interface TwitterUser {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
  description?: string;
}

export interface Mention {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  author?: TwitterUser;
  /**
   * Author of the post this mention replies to. This is the recipient when the
   * command does not name one — the "reply under any post to tip its author"
   * flow the product is built around.
   */
  replyToAuthor?: TwitterUser;
  /** Root of the thread this mention sits in. Used to find rain recipients. */
  conversationId?: string;
  /** The specific post this replies to. Used to resolve `match`. */
  repliedToTweetId?: string;
}

export async function getUserProfile(userId: string): Promise<TwitterUser | null> {
  try {
    const res = await getClient().v2.user(userId, {
      'user.fields': ['id', 'username', 'name', 'profile_image_url', 'description'],
    });
    return (res.data as TwitterUser) ?? null;
  } catch (error) {
    console.error('[twitter] getUserProfile failed', (error as Error)?.message);
    return null;
  }
}

/**
 * Upload a receipt image and return its media id.
 *
 * Deliberately fails soft: a card that will not upload should cost us the
 * picture, not the reply telling someone they were paid.
 */
export async function uploadReceipt(png: Buffer): Promise<string | null> {
  try {
    // The v2 endpoint (POST /2/media/upload), not v1.1: media upload moved to v2
    // and the old host is being retired.
    return await getClient().v2.uploadMedia(png, {
      media_type: 'image/png',
      media_category: 'tweet_image',
    });
  } catch (error) {
    console.error('[twitter] receipt upload failed', (error as Error)?.message);
    return null;
  }
}

/**
 * Does this text contain something X will turn into a link?
 *
 * X charges **$0.20 for a post containing a URL** versus $0.015 for a plain one
 * — thirteen times more — and it auto-links bare domains, so `pourboire.tips`
 * with no scheme costs just as much as the full address. Every reply the bot
 * sends is therefore checked, because a stray domain in a message template is a
 * 13x cost regression that nothing else would surface.
 */
export function containsLink(text: string): boolean {
  if (/\bhttps?:\/\//i.test(text)) return true;
  // A bare domain: at least one label, a dot, then a plausible TLD. Digits after
  // the dot are excluded so "0.5 SOL" and "1.25" do not trip it.
  return /\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|tips|xyz|app|dev|co|gg|fun|sh|to|me|ai|so|link|money)\b/i.test(
    text
  );
}

export async function postTweet(
  text: string,
  replyToTweetId?: string,
  mediaId?: string | null,
  opts: { allowLinks?: boolean } = {}
): Promise<string | null> {
  if (!opts.allowLinks && containsLink(text)) {
    // Not fatal — the person still needs to hear that their money moved — but
    // loud, because it means this post cost 13x what it should have.
    console.warn(
      '[twitter] posting a link-bearing tweet at $0.20 instead of $0.015. Text:',
      text.slice(0, 120)
    );
  }

  try {
    const options: Parameters<TwitterApi['v2']['tweet']>[0] = {
      text: text.length > 280 ? `${text.slice(0, 277)}...` : text,
    };

    if (replyToTweetId) {
      const id = String(replyToTweetId).trim();
      if (!id || id === 'undefined' || id === 'null') {
        console.error('[twitter] refusing to reply to invalid tweet id', replyToTweetId);
        return null;
      }
      options.reply = { in_reply_to_tweet_id: id };
    }

    if (mediaId) {
      options.media = { media_ids: [mediaId] };
    }

    const tweet = await getClient().v2.tweet(options);
    return tweet?.data?.id ?? null;
  } catch (error) {
    const err = error as { message?: string; code?: number; data?: unknown };
    console.error('[twitter] postTweet failed', {
      message: err?.message,
      code: err?.code,
      data: err?.data,
    });
    return null;
  }
}

/**
 * Every reply to a conversation, for drawing giveaway entries.
 *
 * X's search only reaches back seven days, which is why giveaway windows are
 * capped well inside that.
 */
export async function fetchReplies(conversationId: string, max = 500): Promise<Mention[]> {
  const collected: Mention[] = [];
  let nextToken: string | undefined;

  do {
    const res = await getClient().v2.search(`conversation_id:${conversationId}`, {
      'tweet.fields': ['id', 'text', 'author_id', 'created_at'],
      'user.fields': ['id', 'username', 'name', 'profile_image_url'],
      expansions: ['author_id'],
      max_results: 100,
      next_token: nextToken,
    });

    const payload = (res as unknown as { _realData?: unknown })._realData ?? res;
    const raw = payload as {
      data?: unknown;
      includes?: { users?: TwitterUser[] };
      meta?: { next_token?: string };
    };

    const usersById = new Map<string, TwitterUser>();
    for (const u of raw.includes?.users ?? []) usersById.set(u.id, u);

    for (const t of (Array.isArray(raw.data) ? raw.data : []) as Array<Record<string, unknown>>) {
      const authorId = t.author_id ? String(t.author_id) : undefined;
      collected.push({
        id: String(t.id),
        text: String(t.text ?? ''),
        author_id: authorId,
        created_at: t.created_at ? String(t.created_at) : undefined,
        author: authorId ? usersById.get(authorId) : undefined,
      });
    }

    nextToken = raw.meta?.next_token;
  } while (nextToken && collected.length < max);

  return collected;
}

/**
 * Fetch mentions newer than `sinceId`.
 *
 * Throws rather than returning `[]` on failure. The old version swallowed every
 * error and returned an empty array, so an expired token or an exhausted quota
 * looked exactly like "no new tips" — the bot appeared healthy while silently
 * processing nothing.
 */
export async function searchMentions(query: string, sinceId?: string): Promise<Mention[]> {
  const res = await getClient().v2.search(query, {
    'tweet.fields': [
      'id',
      'text',
      'author_id',
      'created_at',
      'in_reply_to_user_id',
      'conversation_id',
      'referenced_tweets',
    ],
    'user.fields': ['id', 'username', 'name', 'profile_image_url'],
    expansions: ['author_id', 'in_reply_to_user_id'],
    max_results: 50,
    since_id: sinceId,
  });

  const payload = (res as unknown as { _realData?: unknown })._realData ?? res;
  const raw = payload as {
    data?: unknown;
    includes?: { users?: TwitterUser[] };
  };

  const tweets: Array<Record<string, unknown>> = Array.isArray(raw.data)
    ? (raw.data as Array<Record<string, unknown>>)
    : [];

  const usersById = new Map<string, TwitterUser>();
  for (const u of raw.includes?.users ?? []) usersById.set(u.id, u);

  return tweets.map((t) => {
    const id = String(t.id);
    const authorId = t.author_id ? String(t.author_id) : undefined;
    const replyToId = t.in_reply_to_user_id ? String(t.in_reply_to_user_id) : undefined;
    const referenced = Array.isArray(t.referenced_tweets)
      ? (t.referenced_tweets as Array<{ type?: string; id?: string }>)
      : [];
    const repliedTo = referenced.find((r) => r.type === 'replied_to')?.id;
    return {
      id,
      text: String(t.text ?? ''),
      author_id: authorId,
      created_at: t.created_at ? String(t.created_at) : undefined,
      author: authorId ? usersById.get(authorId) : undefined,
      replyToAuthor: replyToId ? usersById.get(replyToId) : undefined,
      conversationId: t.conversation_id ? String(t.conversation_id) : undefined,
      repliedToTweetId: repliedTo ? String(repliedTo) : undefined,
    };
  });
}
