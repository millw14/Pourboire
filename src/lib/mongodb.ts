import mongoose from 'mongoose';
import { mongoUri } from './env';

/**
 * Cached connection, shared across hot reloads in dev and across warm
 * invocations in serverless. Without the cache each API request opened a new
 * connection and Atlas ran out of them.
 *
 * The URI is read inside `connectDB`, not at module scope. Reading it at import
 * time meant `next build` crashed on any machine without a production database
 * URI — which is every machine that has just cloned the repo.
 */

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

declare global {
  var _mongooseCache: MongooseCache | undefined;
}

const cached: MongooseCache = global._mongooseCache ?? { conn: null, promise: null };
global._mongooseCache = cached;

export default async function connectDB(): Promise<typeof mongoose> {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = mongoose.connect(mongoUri(), {
      bufferCommands: false,
      // Fail fast rather than letting a route hang until the platform timeout.
      serverSelectionTimeoutMS: 8000,
    });
  }

  try {
    cached.conn = await cached.promise;
  } catch (e) {
    // Clear the rejected promise so the next request retries instead of
    // permanently replaying the same failure.
    cached.promise = null;
    throw e;
  }

  return cached.conn;
}
