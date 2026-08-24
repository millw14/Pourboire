import { TwitterApi } from 'twitter-api-v2';
import { twitterCredentials } from './env';

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
    return await getClient().v1.uploadMedia(png, { mimeType: 'image/png' });
  } catch (error) {
    console.error('[twitter] receipt upload failed', (error as Error)?.message);
    return null;
  }
}

export async function postTweet(
  text: string,
  replyToTweetId?: string,
  mediaId?: string | null
): Promise<string | null> {
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
    'tweet.fields': ['id', 'text', 'author_id', 'created_at', 'in_reply_to_user_id'],
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
    return {
      id,
      text: String(t.text ?? ''),
      author_id: authorId,
      created_at: t.created_at ? String(t.created_at) : undefined,
      author: authorId ? usersById.get(authorId) : undefined,
      replyToAuthor: replyToId ? usersById.get(replyToId) : undefined,
    };
  });
}
