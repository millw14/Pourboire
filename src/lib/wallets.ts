/**
 * Custodial wallet lifecycle, in one place.
 *
 * Four routes each had their own version of "find or create this user's wallet",
 * with three different handle-normalisation strategies between them. One of those
 * versions assigned a fresh keypair over an existing `encryptedPrivateKey`, which
 * permanently orphaned whatever SOL was sitting in the old address — the old key
 * was overwritten, not archived, so the funds became unreachable.
 *
 * The invariant this module enforces: **once a user has an encrypted private key,
 * nothing ever replaces it.**
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import User, { type IUser } from '@/models/User';
import { encryptPrivateKey } from './crypto';
import { normalizeHandle } from './auth';

/** Placeholder id for a wallet pre-created for someone who has not signed in yet. */
export function placeholderTwitterId(handle: string): string {
  // Deterministic, unlike the old `temp_${Date.now()}`, which minted a new id on
  // every call and so could never be matched back to the same person.
  return `pending:${normalizeHandle(handle)}`;
}

export function isPlaceholderTwitterId(id: string | undefined): boolean {
  return Boolean(id?.startsWith('pending:') || id?.startsWith('temp_'));
}

/** Look a user up by any identifier, without the old three-attempt handle dance. */
export async function findUser(params: {
  twitterId?: string;
  handle?: string;
  privyUserId?: string;
}): Promise<IUser | null> {
  const or: Record<string, unknown>[] = [];
  if (params.privyUserId) or.push({ privyUserId: params.privyUserId });
  if (params.twitterId) or.push({ twitterId: params.twitterId });
  if (params.handle) or.push({ handle: normalizeHandle(params.handle) });
  if (!or.length) return null;
  return User.findOne({ $or: or });
}

/**
 * Return the user's custodial wallet, creating one only if they have none.
 *
 * Safe to call concurrently: the upsert uses `$setOnInsert` so two racing callers
 * cannot both write a key, and the duplicate-key path re-reads the winner.
 */
export async function ensureCustodialWallet(params: {
  handle: string;
  twitterId?: string;
  privyUserId?: string;
  name?: string;
  profileImage?: string;
}): Promise<{ user: IUser; created: boolean }> {
  const handle = normalizeHandle(params.handle);

  const existing = await findUser({
    handle,
    twitterId: params.twitterId,
    privyUserId: params.privyUserId,
  });

  if (existing?.encryptedPrivateKey && existing.walletAddress) {
    // Already has a wallet. Fill in identity fields we may have learned since,
    // but never touch the key or the address.
    let dirty = false;
    if (params.privyUserId && existing.privyUserId !== params.privyUserId) {
      existing.privyUserId = params.privyUserId;
      dirty = true;
    }
    if (params.twitterId && isPlaceholderTwitterId(existing.twitterId)) {
      existing.twitterId = params.twitterId;
      existing.claimed = true;
      dirty = true;
    }
    if (params.name && existing.name !== params.name) {
      existing.name = params.name;
      dirty = true;
    }
    if (params.profileImage && existing.profileImage !== params.profileImage) {
      existing.profileImage = params.profileImage;
      dirty = true;
    }
    if (dirty) await existing.save();
    return { user: existing, created: false };
  }

  // A 32-byte secp256k1 key, stored as the 0x-prefixed hex viem expects back.
  const privateKey = generatePrivateKey();
  const encrypted = await encryptPrivateKey(Buffer.from(privateKey.slice(2), 'hex'));
  const walletAddress = privateKeyToAccount(privateKey).address;
  const twitterId = params.twitterId ?? placeholderTwitterId(handle);

  if (existing) {
    // A record exists but has no key yet (e.g. created by the old
    // twitter-callback path with an empty walletAddress). Fill it in.
    existing.walletAddress = walletAddress;
    existing.encryptedPrivateKey = encrypted;
    if (params.privyUserId) existing.privyUserId = params.privyUserId;
    if (params.twitterId) {
      existing.twitterId = params.twitterId;
      existing.claimed = true;
    }
    await existing.save();
    return { user: existing, created: true };
  }

  try {
    const user = await User.findOneAndUpdate(
      { handle },
      {
        $setOnInsert: {
          handle,
          twitterId,
          privyUserId: params.privyUserId,
          name: params.name ?? handle.replace(/^@/, ''),
          profileImage: params.profileImage ?? '',
          bio: '',
          walletAddress,
          encryptedPrivateKey: encrypted,
          isEmbedded: false,
          claimed: Boolean(params.twitterId),
          history: [],
          pendingClaims: [],
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    // `created` is true only if the address we generated is the one that stuck.
    return { user, created: user.walletAddress === walletAddress };
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 11000) {
      // Lost the race. The winner's record is authoritative; ours is discarded.
      const winner = await User.findOne({ handle });
      if (winner) return { user: winner, created: false };
    }
    throw e;
  }
}

/**
 * Resolve the signed-in caller to their database record, creating the custodial
 * wallet on first sign-in. Every authenticated route funnels through this so the
 * account a request acts on is always the caller's own.
 */
export async function resolveCallerUser(caller: {
  privyUserId: string;
  twitterId?: string;
  handle?: string;
  name?: string;
  profileImage?: string;
}): Promise<IUser | null> {
  if (!caller.handle) {
    // No linked X account: we can still find them by Privy id if they have a
    // record, but we will not invent a handle for them.
    return findUser({ privyUserId: caller.privyUserId });
  }
  const { user } = await ensureCustodialWallet({
    handle: caller.handle,
    twitterId: caller.twitterId,
    privyUserId: caller.privyUserId,
    name: caller.name,
    profileImage: caller.profileImage,
  });
  return user;
}
