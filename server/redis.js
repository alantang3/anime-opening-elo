// Redis client shared by Phase 3 (search cache + distributed rate limits +
// Socket.IO adapter) and Phase 4 (match/queue/invite state).
//
// Configure with REDIS_URL — e.g. an Upstash connection string like
//   rediss://default:<password>@<host>.upstash.io:6379
// Without it, every consumer below falls back to its in-memory equivalent
// (current Phase 1/2 behavior), so dev still works with no Redis at all
// and we can deploy code BEFORE flipping on the Upstash side.
//
// We use ioredis (not @upstash/redis REST) because the Socket.IO adapter,
// rate-limit-redis, and the BLPOP/SUBSCRIBE patterns we'll need in Phase 4
// all require a real Redis-protocol connection — not the REST gateway.

import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "";
export const redisEnabled = !!REDIS_URL;

let redis = null;
let pubClient = null;
let subClient = null;

if (redisEnabled) {
  // maxRetriesPerRequest: 3 — tighter than the default so a Redis blip
  // doesn't queue thousands of commands forever; rate-limit-redis is the
  // one consumer that REALLY doesn't want to hold a request open if
  // Redis is sick. keepAlive: 10s keeps Upstash from reaping the idle
  // TLS connection (Upstash closes them after ~30s).
  const opts = {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    keepAlive: 10_000,
  };
  redis = new Redis(REDIS_URL, opts);
  pubClient = redis;
  subClient = redis.duplicate();

  for (const [name, c] of [["main", redis], ["sub", subClient]]) {
    c.on("error", (err) => {
      // Don't crash on transient errors — log and let ioredis retry.
      console.error(`Redis (${name}) error:`, err.message);
    });
  }
  console.log("Redis: enabled");
} else {
  console.log("Redis: disabled (REDIS_URL not set) — using in-process fallbacks");
}

export { redis, pubClient, subClient };
