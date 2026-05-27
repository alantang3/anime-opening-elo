// Phase 4 — multi-instance coordination primitives.
//
// When the app runs as more than one Node process (Render scale >= 2), the
// match/queue/invite state that used to live in a single process's memory has
// to be coordinated across instances. This module is the small, well-defined
// set of Redis-backed primitives that make that possible:
//
//   - INSTANCE_ID      a stable id for THIS process
//   - presence         which instance + socket a given player is on
//   - a pub/sub bus    point-to-point messages to a specific instance
//   - a leader lock    so exactly one instance runs the matchmaker tick
//
// EVERYTHING here degrades to a single-instance no-op when REDIS_URL is unset
// (clusterEnabled === false). In that mode there are no "other" instances, so:
//   - presence lookups return null (caller falls back to its local conns map)
//   - publishToInstance is a no-op (nothing to forward to)
//   - the leader lock is always held (one process is trivially the leader)
// This keeps dev and small single-instance deploys behaving exactly as before.

import crypto from "crypto";
import { redis, redisEnabled } from "./redis.js";

export const clusterEnabled = redisEnabled;

// A stable id for this process. Prefer Render's per-instance value when
// present so logs/keys are recognizable across a deploy; otherwise random.
export const INSTANCE_ID =
  process.env.RENDER_INSTANCE_ID ||
  process.env.INSTANCE_ID ||
  `inst_${crypto.randomBytes(4).toString("hex")}`;

// ---------- key helpers ----------
const kPresence = (playerId) => `presence:player:${playerId}`;
const kInstanceChan = (instanceId) => `inst:${instanceId}`;
const kLeader = (name) => `leader:${name}`;
const kInvite = (code) => `invite:${code}`;
const kInviteHost = (socketId) => `invitehost:${socketId}`;
const kInstanceAlive = (instanceId) => `alive:${instanceId}`;
const kPlayerMatch = (playerId) => `pmatch:${playerId}`;

// An instance refreshes its liveness key on a heartbeat. If a key is missing,
// that instance is presumed dead and the matches it owned are unrecoverable —
// the other instances release the players that were paired with it.
export const INSTANCE_TTL_S = 12;
// player -> {matchId, owner} so a reconnect (even to a different instance) can
// find where their live match is being run. Refreshed by the owner while the
// match is alive; TTL is the dead-match fallback.
export const PLAYER_MATCH_TTL_S = 30 * 60;

// Must match server.js INVITE_TTL_MS (15 min). Redis expires invites for us;
// in the no-Redis fallback we expire them lazily by createdAt.
export const INVITE_TTL_S = 15 * 60;

// Presence entries auto-expire so a crashed instance doesn't leave a player
// looking "online" forever. The server refreshes them on a heartbeat well
// inside this window.
export const PRESENCE_TTL_S = 90;

// ---------- pub/sub bus ----------
// A dedicated subscriber connection (a Redis connection in subscribe mode
// can't issue normal commands, so we can't reuse the main client or the
// Socket.IO adapter's subClient). We publish on the main client.
let clusterSub = null;
const messageHandlers = new Set();

if (clusterEnabled) {
  clusterSub = redis.duplicate();
  clusterSub.on("error", (err) =>
    console.error("Redis (cluster-sub) error:", err.message)
  );
  clusterSub.subscribe(kInstanceChan(INSTANCE_ID), (err) => {
    if (err)
      console.error("cluster: failed to subscribe to own channel:", err.message);
    else console.log(`Cluster: instance ${INSTANCE_ID} listening`);
  });
  clusterSub.on("message", (_channel, raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    for (const h of messageHandlers) {
      try {
        h(msg);
      } catch (err) {
        console.error("cluster message handler:", err.message);
      }
    }
  });
}

// Register a handler for messages addressed to THIS instance. The handler
// receives the parsed message object; server.js dispatches on msg.type.
export function onClusterMessage(handler) {
  messageHandlers.add(handler);
  return () => messageHandlers.delete(handler);
}

// Send a message to a specific instance's channel. No-op (and harmless) when
// clustering is off or the target is unknown.
export async function publishToInstance(instanceId, msg) {
  if (!clusterEnabled || !instanceId) return;
  try {
    await redis.publish(kInstanceChan(instanceId), JSON.stringify(msg));
  } catch (err) {
    console.error("cluster publish:", err.message);
  }
}

// ---------- presence ----------
// Record that `playerId` is connected to THIS instance on `socketId`.
export async function setPresence(playerId, socketId) {
  if (!clusterEnabled || !playerId) return;
  try {
    await redis.set(
      kPresence(playerId),
      JSON.stringify({ instanceId: INSTANCE_ID, socketId }),
      "EX",
      PRESENCE_TTL_S
    );
  } catch (err) {
    console.error("cluster setPresence:", err.message);
  }
}

// Keep this player's presence alive (called on a heartbeat for connected
// players). Cheap EXPIRE rather than a full rewrite.
export async function refreshPresence(playerId) {
  if (!clusterEnabled || !playerId) return;
  try {
    await redis.expire(kPresence(playerId), PRESENCE_TTL_S);
  } catch {
    /* transient — next heartbeat retries */
  }
}

// Clear presence on disconnect, but only if WE still own it (guards against
// clobbering a fast reconnect that already landed on another instance).
export async function clearPresence(playerId, socketId) {
  if (!clusterEnabled || !playerId) return;
  try {
    const cur = await getPresence(playerId);
    if (cur && cur.instanceId === INSTANCE_ID && cur.socketId === socketId)
      await redis.del(kPresence(playerId));
  } catch (err) {
    console.error("cluster clearPresence:", err.message);
  }
}

// Where is this player? -> { instanceId, socketId } or null.
export async function getPresence(playerId) {
  if (!clusterEnabled || !playerId) return null;
  try {
    const raw = await redis.get(kPresence(playerId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export const isLocalInstance = (instanceId) =>
  !instanceId || instanceId === INSTANCE_ID;

// ---------- instance liveness ----------
export async function instanceHeartbeat() {
  if (!clusterEnabled) return;
  try {
    await redis.set(kInstanceAlive(INSTANCE_ID), "1", "EX", INSTANCE_TTL_S);
  } catch {
    /* transient — next heartbeat retries */
  }
}

export async function instanceIsAlive(instanceId) {
  if (!clusterEnabled) return true;
  if (instanceId === INSTANCE_ID) return true;
  try {
    return (await redis.exists(kInstanceAlive(instanceId))) === 1;
  } catch {
    // On a Redis blip, assume alive — don't tear down good matches over a hiccup.
    return true;
  }
}

// ---------- player -> live match registry ----------
export async function playerMatchSet(playerId, matchId, owner) {
  if (!clusterEnabled || !playerId) return;
  try {
    await redis.set(
      kPlayerMatch(playerId),
      JSON.stringify({ matchId, owner }),
      "EX",
      PLAYER_MATCH_TTL_S
    );
  } catch (err) {
    console.error("cluster playerMatchSet:", err.message);
  }
}

export async function playerMatchRefresh(playerId) {
  if (!clusterEnabled || !playerId) return;
  try {
    await redis.expire(kPlayerMatch(playerId), PLAYER_MATCH_TTL_S);
  } catch {
    /* next refresh retries */
  }
}

export async function playerMatchGet(playerId) {
  if (!clusterEnabled || !playerId) return null;
  try {
    const raw = await redis.get(kPlayerMatch(playerId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Clear iff it still points at the given match (avoids a teardown clobbering a
// fresh match the player has already joined).
export async function playerMatchClear(playerId, matchId) {
  if (!clusterEnabled || !playerId) return;
  try {
    const cur = await playerMatchGet(playerId);
    if (cur && (!matchId || cur.matchId === matchId))
      await redis.del(kPlayerMatch(playerId));
  } catch (err) {
    console.error("cluster playerMatchClear:", err.message);
  }
}

// ---------- invites ----------
// An invite record is { code, hostSocketId, hostPlayerId, hostInstance,
// createdAt }. Stored in Redis so a friend who lands on a DIFFERENT instance
// can still find the host's code. Each host has at most one active invite
// (createInvite clears the previous), so invitehost:<socketId> -> code is a
// sufficient reverse index for removeInvitesBy. When Redis is off we keep the
// same shape in a local Map with lazy createdAt expiry.
const localInvites = new Map(); // code -> rec
const localInviteByHost = new Map(); // hostSocketId -> code

function localInviteFresh(rec) {
  return !!rec && Date.now() - rec.createdAt < INVITE_TTL_S * 1000;
}

export async function inviteCreate(rec) {
  if (!clusterEnabled) {
    localInvites.set(rec.code, rec);
    localInviteByHost.set(rec.hostSocketId, rec.code);
    return;
  }
  await redis
    .multi()
    .set(kInvite(rec.code), JSON.stringify(rec), "EX", INVITE_TTL_S)
    .set(kInviteHost(rec.hostSocketId), rec.code, "EX", INVITE_TTL_S)
    .exec();
}

export async function inviteGet(code) {
  if (!clusterEnabled) {
    const rec = localInvites.get(code);
    if (!localInviteFresh(rec)) {
      if (rec) {
        localInvites.delete(code);
        localInviteByHost.delete(rec.hostSocketId);
      }
      return null;
    }
    return rec;
  }
  try {
    const raw = await redis.get(kInvite(code));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function inviteExists(code) {
  if (!clusterEnabled) return localInviteFresh(localInvites.get(code));
  try {
    return (await redis.exists(kInvite(code))) === 1;
  } catch {
    return false;
  }
}

export async function inviteDelete(code) {
  if (!clusterEnabled) {
    const rec = localInvites.get(code);
    localInvites.delete(code);
    if (rec) localInviteByHost.delete(rec.hostSocketId);
    return;
  }
  const rec = await inviteGet(code);
  const m = redis.multi().del(kInvite(code));
  if (rec) m.del(kInviteHost(rec.hostSocketId));
  await m.exec();
}

// Remove whatever invite this host socket created (if any). Returns the
// removed code or null.
export async function inviteRemoveByHost(socketId) {
  if (!clusterEnabled) {
    const code = localInviteByHost.get(socketId);
    if (code) {
      localInvites.delete(code);
      localInviteByHost.delete(socketId);
    }
    return code || null;
  }
  try {
    const code = await redis.get(kInviteHost(socketId));
    if (!code) return null;
    await redis.multi().del(kInvite(code)).del(kInviteHost(socketId)).exec();
    return code;
  } catch {
    return null;
  }
}

// ---------- matchmaking queue ----------
// A shared FIFO-ish pool so players on ANY instance can be paired. Stored as
// a Redis hash socketId -> entry, where an entry is
//   { socketId, playerId, instanceId, queuedAt, eloAtQueue }
// The leader instance reads the whole pool each tick, runs the Elo-band
// pairing, and atomically CLAIMS a pair (Lua) so two ticks / a cancel can't
// double-book a player. No-Redis fallback uses a local Map with the same API.
const QUEUE_KEY = "mmqueue";
const localQueue = new Map(); // socketId -> entry

export async function queueAdd(entry) {
  if (!clusterEnabled) {
    localQueue.set(entry.socketId, entry);
    return;
  }
  try {
    await redis.hset(QUEUE_KEY, entry.socketId, JSON.stringify(entry));
  } catch (err) {
    console.error("cluster queueAdd:", err.message);
  }
}

export async function queueRemove(socketId) {
  if (!clusterEnabled) {
    localQueue.delete(socketId);
    return;
  }
  try {
    await redis.hdel(QUEUE_KEY, socketId);
  } catch (err) {
    console.error("cluster queueRemove:", err.message);
  }
}

export async function queueHas(socketId) {
  if (!clusterEnabled) return localQueue.has(socketId);
  try {
    return (await redis.hexists(QUEUE_KEY, socketId)) === 1;
  } catch {
    return false;
  }
}

// Snapshot of the whole pool as parsed entries (leader reads this once/tick).
export async function queueAll() {
  if (!clusterEnabled) return [...localQueue.values()];
  try {
    const all = await redis.hgetall(QUEUE_KEY);
    const out = [];
    for (const raw of Object.values(all || {})) {
      try {
        out.push(JSON.parse(raw));
      } catch {
        /* skip corrupt entry */
      }
    }
    return out;
  } catch {
    return [];
  }
}

const CLAIM_PAIR_LUA = `
local a = redis.call('hget', KEYS[1], ARGV[1])
local b = redis.call('hget', KEYS[1], ARGV[2])
if a and b then
  redis.call('hdel', KEYS[1], ARGV[1], ARGV[2])
  return {a, b}
end
return nil`;

// Atomically remove both socketIds from the pool. Returns [aEntry, bEntry] if
// BOTH were still present (we won the pair), else null (someone vanished).
export async function queueClaimPair(aSock, bSock) {
  if (!clusterEnabled) {
    const a = localQueue.get(aSock);
    const b = localQueue.get(bSock);
    if (a && b) {
      localQueue.delete(aSock);
      localQueue.delete(bSock);
      return [a, b];
    }
    return null;
  }
  try {
    const r = await redis.eval(CLAIM_PAIR_LUA, 1, QUEUE_KEY, aSock, bSock);
    return r ? [JSON.parse(r[0]), JSON.parse(r[1])] : null;
  } catch (err) {
    console.error("cluster queueClaimPair:", err.message);
    return null;
  }
}

const CLAIM_ONE_LUA = `
local a = redis.call('hget', KEYS[1], ARGV[1])
if a then redis.call('hdel', KEYS[1], ARGV[1]); return a end
return nil`;

// Atomically remove one socketId (bot fallback). Returns the entry or null.
export async function queueClaimOne(sock) {
  if (!clusterEnabled) {
    const a = localQueue.get(sock);
    if (a) {
      localQueue.delete(sock);
      return a;
    }
    return null;
  }
  try {
    const r = await redis.eval(CLAIM_ONE_LUA, 1, QUEUE_KEY, sock);
    return r ? JSON.parse(r) : null;
  } catch (err) {
    console.error("cluster queueClaimOne:", err.message);
    return null;
  }
}

// ---------- leader lock ----------
// Atomically acquire-or-renew a lock keyed by `name`. Returns true if THIS
// instance holds it after the call. Used to elect a single matchmaker so two
// instances can't pull the same player from the shared queue. Calling this on
// an interval (period < ttl) both renews our hold and lets another instance
// take over within `ttlMs` if we die. When clustering is off we're always the
// leader (single process).
const LEADER_LUA = `
local v = redis.call('get', KEYS[1])
if v == false or v == ARGV[1] then
  redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
else
  return 0
end`;

export async function acquireOrRenewLeader(name, ttlMs) {
  if (!clusterEnabled) return true;
  try {
    const r = await redis.eval(LEADER_LUA, 1, kLeader(name), INSTANCE_ID, ttlMs);
    return r === 1;
  } catch (err) {
    console.error("cluster leader:", err.message);
    // On a Redis blip, don't seize leadership (avoids split-brain double
    // matchmaking); the holder keeps it until its PX expires.
    return false;
  }
}

// Release the lock iff we hold it (best-effort, used on graceful shutdown).
const RELEASE_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

export async function releaseLeader(name) {
  if (!clusterEnabled) return;
  try {
    await redis.eval(RELEASE_LUA, 1, kLeader(name), INSTANCE_ID);
  } catch {
    /* it'll expire on its own */
  }
}

// ---------- player IP registry + reports / bans ----------
// We track reports and bans by IP, shared across instances via Redis (so a ban
// holds everywhere). To report the OPPONENT we need their IP even when they're
// on another instance, so each authed player's IP is stored by playerId.
const kPlayerIp = (playerId) => `playerip:${playerId}`;
const kBan = (ip) => `ban:${ip}`;
const kReporters = (ip) => `reporters:${ip}`;

export const REPORTS_TO_BAN = 3; // distinct reporters needed
export const BAN_SECONDS = 7 * 24 * 60 * 60; // 1 week
const PLAYER_IP_TTL_S = 24 * 60 * 60; // refreshed on the presence heartbeat
// Reports decay on a rolling window so an IP isn't permanently 2/3-reported
// (IPs get reassigned). Hitting REPORTS_TO_BAN within this window bans; after
// the ban expires the counter is already cleared, so they start fresh.
const REPORTERS_TTL_S = 7 * 24 * 60 * 60;

const localPlayerIp = new Map(); // playerId -> ip
const localBans = new Map(); // ip -> expiresAtMs
const localReporters = new Map(); // ip -> Set(reporterKey)

export async function setPlayerIp(playerId, ip) {
  if (!playerId || !ip) return;
  if (!clusterEnabled) {
    localPlayerIp.set(playerId, ip);
    return;
  }
  try {
    await redis.set(kPlayerIp(playerId), ip, "EX", PLAYER_IP_TTL_S);
  } catch (err) {
    console.error("cluster setPlayerIp:", err.message);
  }
}

export async function refreshPlayerIp(playerId) {
  if (!clusterEnabled || !playerId) return;
  try {
    await redis.expire(kPlayerIp(playerId), PLAYER_IP_TTL_S);
  } catch {
    /* next heartbeat retries */
  }
}

export async function getPlayerIp(playerId) {
  if (!playerId) return null;
  if (!clusterEnabled) return localPlayerIp.get(playerId) || null;
  try {
    return (await redis.get(kPlayerIp(playerId))) || null;
  } catch {
    return null;
  }
}

export async function isIpBanned(ip) {
  if (!ip) return false;
  if (!clusterEnabled) {
    const exp = localBans.get(ip);
    if (exp && exp > Date.now()) return true;
    if (exp) localBans.delete(ip);
    return false;
  }
  try {
    return (await redis.exists(kBan(ip))) === 1;
  } catch {
    return false;
  }
}

export async function banRemainingMs(ip) {
  if (!ip) return 0;
  if (!clusterEnabled) {
    const exp = localBans.get(ip);
    return exp ? Math.max(0, exp - Date.now()) : 0;
  }
  try {
    const t = await redis.pttl(kBan(ip));
    return t > 0 ? t : 0;
  } catch {
    return 0;
  }
}

// Record a report against `reportedIp` from a distinct `reporterKey`. When
// REPORTS_TO_BAN distinct reporters accumulate, the IP is banned for
// BAN_SECONDS and the counter is cleared. Returns { banned, count }.
export async function reportTarget(reportedIp, reporterKey) {
  if (!reportedIp || !reporterKey) return { banned: false, count: 0 };
  if (!clusterEnabled) {
    let set = localReporters.get(reportedIp);
    if (!set) {
      set = new Set();
      localReporters.set(reportedIp, set);
    }
    set.add(reporterKey);
    if (set.size >= REPORTS_TO_BAN) {
      localBans.set(reportedIp, Date.now() + BAN_SECONDS * 1000);
      localReporters.delete(reportedIp);
      return { banned: true, count: set.size };
    }
    return { banned: false, count: set.size };
  }
  try {
    await redis.sadd(kReporters(reportedIp), reporterKey);
    await redis.expire(kReporters(reportedIp), REPORTERS_TTL_S);
    const count = await redis.scard(kReporters(reportedIp));
    if (count >= REPORTS_TO_BAN) {
      await redis.set(kBan(reportedIp), "1", "EX", BAN_SECONDS);
      await redis.del(kReporters(reportedIp));
      return { banned: true, count };
    }
    return { banned: false, count };
  } catch (err) {
    console.error("cluster reportTarget:", err.message);
    return { banned: false, count: 0 };
  }
}
