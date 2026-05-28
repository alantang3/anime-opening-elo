// Anime Opening Elo — real-time multiplayer backend.
//
// Two players are matched from a FIFO queue, hear the SAME opening in sync,
// and race to name the anime (unlimited guesses). First correct wins; Elo is
// exchanged, scaled by the show's MAL popularity (obscure = big swing). If the
// opening ends with nobody correct, both lose points. After a round both must
// vote to rematch the same opponent, else they go back to the queue.
//
// The server is authoritative on everything that matters: it holds the answer
// (clients never receive it until the round ends), runs the round timer, and
// settles Elo. Clients only report their loaded media duration so the timer
// can match the song length without trusting a single client.

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import http from "http";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Server } from "socket.io";

import {
  getPlayer,
  applyMatchResult,
  leaderboard,
  setNickname,
  setCustomAvatar,
  createGuestPlayer,
  getPlayerStats,
  DATA_DIR,
} from "./db.js";
import {
  searchAnime,
  getThemeMediaLinks,
  getCachedThemeMediaLinks,
} from "./animethemes.js";
import { isCorrect } from "./matching.js";
import { pickOpeningForElo } from "./selectOpening.js";
import { startIngester } from "./pool.js";
import { resolveWin, resolveTimeout } from "./elo.js";
import {
  GOOGLE_CLIENT_ID,
  loginWithGoogle,
  loginWithGoogleAccessToken,
  verifySession,
  issueSession,
} from "./auth.js";
import { putAvatar, AVATAR_MIME_TO_EXT, LOCAL_AVATAR_DIR } from "./storage.js";
import { redis, redisEnabled, pubClient, subClient } from "./redis.js";
import { createAdapter } from "@socket.io/redis-adapter";
import { RedisStore as RateLimitRedisStore } from "rate-limit-redis";
import {
  clusterEnabled,
  INSTANCE_ID,
  onClusterMessage,
  publishToInstance,
  setPresence,
  refreshPresence,
  clearPresence,
  getPresence,
  isLocalInstance,
  acquireOrRenewLeader,
  releaseLeader,
  inviteCreate,
  inviteGet,
  inviteExists,
  inviteDelete,
  inviteRemoveByHost,
  queueAdd,
  queueRemove,
  queueHas,
  queueAll,
  queueClaimPair,
  queueClaimOne,
  instanceHeartbeat,
  instanceIsAlive,
  playerMatchSet,
  playerMatchRefresh,
  playerMatchGet,
  playerMatchClear,
  setPlayerIp,
  refreshPlayerIp,
  getPlayerIp,
  isIpBanned,
  banRemainingMs,
  reportTarget,
} from "./cluster.js";

// ---------- Tunables ----------
const PORT = process.env.PORT || 5174;
const COUNTDOWN_MS = 3000; // 3-2-1 before audio, masks network jitter
const DURATION_MIN_MS = 10_000;
const DURATION_MAX_MS = 120_000; // OPs are ~90s; hard cap against a lying client
const DURATION_FALLBACK_MS = 90_000; // used if neither client reports in time
const DURATION_REPORT_WAIT_MS = 8_000;
const REMATCH_TIMEOUT_MS = 150_000;
// No human opponent within this long in the random queue → play a bot.
const BOT_WAIT_MS = Number(process.env.BOT_WAIT_MS) || 10_000;
const BOT_ELO_JITTER = 40; // bot rating = your Elo ± up to this
const BOT_BASE_ACCURACY = 0.55; // chance the bot gets it, before popularity
const INVITE_TTL_MS = 15 * 60 * 1000;

// Plausible player handles — deliberately NOT obviously a bot.
const BOT_NAMES = [
  "kuro_92", "hikari", "renji", "aoi_x", "tsubasa", "yukidoke",
  "kenji", "mirae", "haru", "sora", "rei_", "akira",
  "nao", "rikuu", "emi_chan", "shinji", "kaze", "yuna",
];

// ---------- HTTP ----------
const app = express();
// Render/Fly terminate TLS at a front proxy; trust the immediate hop so
// express-rate-limit sees the real client IP via X-Forwarded-For instead
// of every request looking like it came from the load balancer.
app.set("trust proxy", 1);
app.use(cors());
// Security headers. CSP is disabled because the SPA + Google Identity
// Services iframe + inline styles from Vite would need a carefully-tuned
// policy; ship the rest now and add CSP separately once we can test it.
// CORP is set to cross-origin so the static avatar files / images remain
// loadable from the SPA during dev (Vite on a different port).
// COOP must be "same-origin-allow-popups": Google Identity Services'
// popup flow does window.opener.postMessage back to us with the
// credential — the stricter "same-origin" default silently swallows
// that message, so the popup closes successfully but the client never
// receives the token and the sign-in just stalls.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  })
);
app.use(express.json({ limit: "3mb" })); // headroom for base64 avatar uploads

// ---------- Rate limits (per-IP) ----------
// Public endpoints only. Authenticated socket events are throttled below
// via a per-socket sliding window.
//
// Phase 3 (multi-instance): rate limits are backed by Redis when configured.
// Without Redis, every instance keeps its own counter — so an attacker with
// two requests routed to different instances counts as 1/limit on EACH. With
// Redis the counter is global. We fall back to the in-memory store when
// REDIS_URL isn't set so dev still works.
const rl = (windowMs, limit, message) => {
  const opts = {
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: message ? { error: message } : undefined,
  };
  if (redisEnabled) {
    // sendCommand: the rate-limit-redis store is client-agnostic; we feed
    // it raw command arrays for ioredis to execute. Key prefix keeps the
    // limiter's keys namespaced so they don't collide with Phase 4 keys.
    opts.store = new RateLimitRedisStore({
      sendCommand: (...args) => redis.call(...args),
      prefix: "rl:",
    });
  }
  return rateLimit(opts);
};
// Autocomplete fires per keystroke; legitimate users blow past 60/min
// easily (a few search sessions in a minute). 120/min/IP still kills the
// iterate-uniques cache-bypass attack since each unique query also has
// to clear the 2..50 char length gate below.
const limitSearch = rl(60_000, 120);
// One IP creating 5 guest accounts a day is plenty; anything more is bot
// spam polluting the players table.
const limitGuestAuth = rl(
  24 * 60 * 60_000,
  5,
  "Too many guest sign-ups from this network today. Try again tomorrow."
);
const limitGoogleAuth = rl(60 * 60_000, 20);
const limitAvatarUpload = rl(60 * 60_000, 5, "Slow down on avatar changes.");
const limitMeRead = rl(60_000, 60);
const limitLeaderboard = rl(60_000, 60);

// Phase 2 (object storage): user-uploaded avatars are stored in Cloudflare
// R2 when configured (see storage.js), falling back to the local disk dir
// otherwise. We still mount the /avatars static route in BOTH modes so any
// pre-R2 rows (or rows written during a fallback deploy) keep resolving
// without a one-shot migration job.
app.use(
  "/avatars",
  express.static(LOCAL_AVATAR_DIR, { maxAge: "1h", immutable: false })
);

// Pull the authenticated player from a Bearer session token (HTTP routes;
// the socket has its own auth). Returns the player row or null.
async function authPlayer(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  const s = m && verifySession(m[1]);
  return s?.sub ? await getPlayer(s.sub) : null;
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Public config the client needs to render the Google button.
app.get("/api/config", (_req, res) =>
  res.json({ googleClientId: GOOGLE_CLIENT_ID })
);

// Cloudflare Realtime TURN: mints short-lived ICE credentials so the client
// can establish reliable peer-to-peer (camera/mic) across NATs. The API token
// MUST stay server-side. We cache the credentials in-process (24h TTL, refresh
// after 23h) so we don't call Cloudflare on every page load. Falls back to
// returning an empty list if not configured — the client still has the STUN +
// free openrelay defaults baked in.
let turnCache = null; // { iceServers, refreshAt }
async function getTurnCredentials() {
  const tokenId = process.env.CF_TURN_TOKEN_ID;
  const apiToken = process.env.CF_TURN_API_TOKEN;
  if (!tokenId || !apiToken) return null;
  if (turnCache && turnCache.refreshAt > Date.now()) return turnCache.iceServers;
  const r = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${tokenId}/credentials/generate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: 24 * 60 * 60 }),
    }
  );
  if (!r.ok) throw new Error(`Cloudflare TURN HTTP ${r.status}`);
  const data = await r.json();
  // Cloudflare returns { iceServers: {...} } or { iceServers: [...] };
  // normalize to an array so the client can hand it straight to RTCPeerConnection.
  let ice = data?.iceServers;
  if (!ice) throw new Error("Cloudflare TURN: no iceServers in response");
  if (!Array.isArray(ice)) ice = [ice];
  turnCache = {
    iceServers: ice,
    refreshAt: Date.now() + 23 * 60 * 60 * 1000,
  };
  return ice;
}
app.get("/api/turn", async (_req, res) => {
  try {
    const ice = await getTurnCredentials();
    res.json({ iceServers: ice || [] });
  } catch (err) {
    console.error("api/turn:", err.message);
    res.json({ iceServers: [] });
  }
});

// Exchange a Google credential for our session token. Accepts either an ID
// token (legacy GIS button) or an OAuth access token (our custom button).
app.post("/api/auth/google", limitGoogleAuth, async (req, res) => {
  try {
    const { credential, accessToken } = req.body || {};
    const { token, player } = accessToken
      ? await loginWithGoogleAccessToken(accessToken)
      : await loginWithGoogle(credential);
    res.json({ token, player: publicPlayer(player) });
  } catch (err) {
    console.error("auth/google:", err.message);
    res.status(401).json({ error: "Google sign-in failed" });
  }
});

// Guest sign-in: takes a nickname and optional base64 avatar (data URL),
// creates a brand-new account, returns a session token like Google does.
// No password, no email — they just play as that account until they clear
// their browser. Same rate-limit and image-size rules as the avatar upload.
app.post("/api/auth/guest", limitGuestAuth, async (req, res) => {
  try {
    const { nickname, avatar: dataUrl } = req.body || {};
    const clean = String(nickname || "").replace(/\s+/g, " ").trim().slice(0, 24);
    if (clean.length < 2)
      return res.status(400).json({ error: "name must be 2-24 chars" });
    // First create the player (so we have an id to key the avatar file by).
    let player = await createGuestPlayer({ nickname: clean, avatar: null });
    // Optional avatar upload via base64 data URL.
    if (dataUrl) {
      const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(String(dataUrl));
      if (!m) return res.status(400).json({ error: "expected png/jpeg/webp" });
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > 1_200_000)
        return res.status(413).json({ error: "image too large (max ~1.2MB)" });
      const ext = AVATAR_MIME_TO_EXT[m[1]];
      let url;
      try {
        url = await putAvatar(player.id, ext, buf, m[1]);
      } catch (e) {
        console.error("putAvatar (guest):", e.message);
        return res.status(500).json({ error: "could not save image" });
      }
      player = await setCustomAvatar(player.id, url);
    }
    res.json({ token: issueSession(player), player: publicPlayer(player) });
  } catch (err) {
    console.error("auth/guest:", err.message);
    res.status(500).json({ error: "guest sign-in failed" });
  }
});

// Autocomplete is the other per-keystroke AnimeThemes call, so cache it:
// short TTL. Many users type the same prefixes ("nar", "one"…), so this
// collapses huge numbers of identical lookups into one.
//
// Phase 3: shared Redis cache when configured (one instance warms it,
// all instances benefit), falling back to a per-instance Map otherwise.
const SEARCH_TTL_S = 600; // 10 min
const SEARCH_TTL_MS = SEARCH_TTL_S * 1000;
const SEARCH_CACHE_MAX = 500;
const localSearchCache = new Map(); // q -> { at, results }

async function getCachedSearch(q) {
  if (redisEnabled) {
    try {
      const raw = await redis.get(`search:${q}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null; // Redis hiccup — let the caller re-fetch.
    }
  }
  const hit = localSearchCache.get(q);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.results;
  return null;
}

async function setCachedSearch(q, results) {
  if (redisEnabled) {
    try {
      // EX 600s — Redis evicts automatically; no manual LRU needed.
      await redis.set(`search:${q}`, JSON.stringify(results), "EX", SEARCH_TTL_S);
    } catch {
      /* best-effort cache */
    }
    return;
  }
  localSearchCache.set(q, { at: Date.now(), results });
  if (localSearchCache.size > SEARCH_CACHE_MAX)
    localSearchCache.delete(localSearchCache.keys().next().value); // evict oldest
}

app.get("/api/search", limitSearch, async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  // Length-bound the query before doing anything else. Stops the
  // iterate-uniques cache-bypass abuse (?q=a, ?q=aa, ?q=aaa, …) AND
  // empty/typo'd hits that wouldn't return useful results anyway.
  if (q.length < 2 || q.length > 50) return res.json({ results: [] });
  const cached = await getCachedSearch(q);
  if (cached) return res.json({ results: cached });
  try {
    const results = await searchAnime(q);
    await setCachedSearch(q, results);
    res.json({ results });
  } catch (err) {
    console.error("search:", err.message);
    if (cached) return res.json({ results: cached }); // serve stale on error
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Seeded "ghost" players so the board looks lively and gives newcomers
// something to chase. They never enter matchmaking (no socket) — purely
// display, merged with real players and sorted by Elo.
const GHOST_PLAYERS = [
  // Records scale with Elo and are ALL winning: ~81% win rate at the top
  // tapering to ~56% at the bottom (still positive), more games up top.
  { id: "ghost:1",  nickname: "KamiSpeed",   elo: 5111, wins: 712, losses: 168, draws: 52, avatar: "/default.png" },
  { id: "ghost:2",  nickname: "OPSniper",    elo: 4998, wins: 680, losses: 176, draws: 48, avatar: "/default.png" },
  { id: "ghost:3",  nickname: "SakuraBlitz", elo: 4667, wins: 651, losses: 184, draws: 27, avatar: "/default.png" },
  { id: "ghost:4",  nickname: "ZeroFrame",   elo: 4248, wins: 624, losses: 191, draws: 31, avatar: "/default.png" },
  { id: "ghost:5",  nickname: "TitanEar",    elo: 4022, wins: 598, losses: 198, draws: 29, avatar: "/default.png" },
  { id: "ghost:6",  nickname: "RamenGod",    elo: 3902, wins: 573, losses: 205, draws: 26, avatar: "/default.png" },
  { id: "ghost:7",  nickname: "NanoDesu",    elo: 3784, wins: 549, losses: 211, draws: 33, avatar: "/default.png" },
  { id: "ghost:8",  nickname: "EdTune",      elo: 3667, wins: 526, losses: 216, draws: 37, avatar: "/default.png" },
  { id: "ghost:9",  nickname: "PlusUltra",   elo: 3541, wins: 504, losses: 221, draws: 43, avatar: "/default.png" },
  { id: "ghost:10", nickname: "SenpaiFM",    elo: 3423, wins: 483, losses: 225, draws: 22, avatar: "/default.png" },
  { id: "ghost:11", nickname: "GokuVibes",   elo: 3300, wins: 462, losses: 229, draws: 19, avatar: "/default.png" },
  { id: "ghost:12", nickname: "MikuMain",    elo: 3188, wins: 442, losses: 232, draws: 101, avatar: "/default.png" },
  { id: "ghost:13", nickname: "ChibiRush",   elo: 3060, wins: 423, losses: 235, draws: 24, avatar: "/default.png" },
  { id: "ghost:14", nickname: "OtakuPrime",  elo: 2954, wins: 405, losses: 237, draws: 18, avatar: "/default.png" },
  { id: "ghost:15", nickname: "LoFiLeaf",    elo: 2845, wins: 388, losses: 239, draws: 17, avatar: "/default.png" },
  { id: "ghost:16", nickname: "AceQuil",    elo: 2736, wins: 371, losses: 240, draws: 23, avatar: "/default.png" },
  { id: "ghost:17", nickname: "NovaBeat",    elo: 2622, wins: 355, losses: 241, draws: 24, avatar: "/default.png" },
  { id: "ghost:18", nickname: "RoninLoop",   elo: 2526, wins: 340, losses: 242, draws: 29, avatar: "/default.png" },
  { id: "ghost:19", nickname: "HikariWave",  elo: 2428, wins: 326, losses: 242, draws: 17, avatar: "/default.png" },
  { id: "ghost:20", nickname: "DubLordX",   elo: 2275, wins: 312, losses: 243, draws: 18, avatar: "/default.png" },
];

app.get("/api/leaderboard", limitLeaderboard, async (_req, res) => {
  const merged = [...(await leaderboard(50)), ...GHOST_PLAYERS]
    .sort((a, b) => b.elo - a.elo)
    .slice(0, 20);
  res.json({ players: merged });
});

// Stats + recent matches for the signed-in player.
app.get("/api/me/stats", limitMeRead, async (req, res) => {
  const p = await authPlayer(req);
  if (!p) return res.status(401).json({ error: "sign in" });
  res.json(await getPlayerStats(p.id, 12));
});

// Upload a custom profile picture (base64 data URL in JSON). Storage layer
// decides whether the bytes land in R2 or the local fallback dir.
app.post("/api/me/avatar", limitAvatarUpload, async (req, res) => {
  const p = await authPlayer(req);
  if (!p) return res.status(401).json({ error: "sign in" });
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(
    String(req.body?.image || "")
  );
  if (!m) return res.status(400).json({ error: "expected png/jpeg/webp" });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 1_200_000)
    return res.status(413).json({ error: "image too large (max ~1.2MB)" });
  const ext = AVATAR_MIME_TO_EXT[m[1]];
  let url;
  try {
    url = await putAvatar(p.id, ext, buf, m[1]);
  } catch (e) {
    console.error("putAvatar (me):", e.message);
    return res.status(500).json({ error: "could not save image" });
  }
  const updated = await setCustomAvatar(p.id, url);
  res.json({ player: publicPlayer(updated) });
});

// ---------- Static frontend (production single-service) ----------
// In dev the client runs on Vite, which proxies /api and /socket.io here.
// In production this same process also serves the built React app, so the
// whole thing is one deploy on one origin (no CORS, no separate frontend).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(__dirname, "..", "client", "dist");
if (fs.existsSync(path.join(CLIENT_DIST, "index.html"))) {
  app.use(express.static(CLIENT_DIST));
  // SPA fallback: any non-API GET returns index.html. Socket.IO intercepts
  // /socket.io before Express, so it never reaches this.
  app.get(/^\/(?!api\/).*/, (_req, res) =>
    res.sendFile(path.join(CLIENT_DIST, "index.html"))
  );
  console.log("Serving built client from", CLIENT_DIST);
}

const server = http.createServer(app);
// Transport choice matters for horizontal scaling. HTTP long-polling makes
// several requests per session that MUST hit the same instance, which needs
// sticky sessions at the load balancer (Render doesn't reliably offer them).
// A WebSocket is a single long-lived connection to one instance, so it needs
// no stickiness — combined with the Redis adapter (cross-instance
// broadcasts) it's the canonical Socket.IO scale-out setup. So when we're
// clustered we force websocket-only; single-instance keeps polling as a
// fallback for restrictive networks.
const io = new Server(server, {
  cors: { origin: true },
  transports: clusterEnabled ? ["websocket"] : ["polling", "websocket"],
});

// Phase 3: when Redis is configured, swap the in-memory adapter for the
// Redis pub/sub adapter. This is the prerequisite for multi-instance —
// emits to a room "match:<id>" now reach sockets connected to OTHER
// instances via Redis pub/sub. With no Redis, the default in-memory
// adapter keeps single-instance behavior identical to Phase 1/2.
if (redisEnabled) {
  io.adapter(createAdapter(pubClient, subClient));
  console.log("Socket.IO: Redis adapter active");
}
if (clusterEnabled) {
  console.log(`Cluster: multi-instance mode, instance id ${INSTANCE_ID}`);
} else {
  console.log("Cluster: single-instance mode (REDIS_URL not set)");
}

// ---------- Connection + match state ----------
// socket.id -> { socket, player, status: 'idle'|'queued'|'match', matchId }
const conns = new Map();
// The FIFO matchmaking queue now lives in Redis (server/cluster.js) so all
// instances share one pool; a single leader instance runs the pairing tick.
// Falls back to an in-process map when REDIS_URL is unset.
// matchId -> Match
const matches = new Map();
// Invites live in Redis (server/cluster.js) so a friend who connects to a
// different instance can still resolve the host's code; falls back to an
// in-process map when REDIS_URL is unset.

const snapshot = (row) => ({
  id: row.id,
  nickname: row.nickname,
  elo: Math.round(row.elo),
  eloRaw: row.elo,
  wins: row.wins,
  losses: row.losses,
  draws: row.draws,
});

function publicPlayer(row) {
  const s = snapshot(row);
  return {
    nickname: s.nickname,
    elo: s.elo,
    wins: s.wins,
    losses: s.losses,
    avatar: row.avatar || null,
  };
}

// ---------- Matchmaking ----------
// Tiered Elo bands: the band you'll accept widens with wait time so a
// just-queued player isn't immediately paired against someone wildly out
// of their range, but a long-waiting player isn't punished by an empty
// queue. Within the band, we pair with the LONGEST-WAITING viable
// partner (not by closest Elo) — feels fairer because the person who's
// been waiting longest gets served first.
//
//   wait < 5s  → ±600 Elo
//   wait < 10s → ±1000 Elo
//   wait ≥ 10s → any Elo; if still no human, bot
const BAND_TIER_1_MS = 5_000;
const BAND_TIER_1_ELO = 600;
const BAND_TIER_2_MS = 10_000;
const BAND_TIER_2_ELO = 1000;
// The matchmaker tick re-runs even when nobody joins/leaves so that band
// widening (and the bot fallback at BOT_WAIT_MS) fire on time. 1s
// resolution means worst-case bot-fallback is BOT_WAIT_MS + 1s.
const MATCHMAKER_TICK_MS = 1000;

// Exactly ONE instance runs the pairing tick (the "matchmaker leader") so two
// instances can't pull the same player from the shared queue. We hold a
// Redis lock with a short TTL and renew it on a heartbeat; if the leader dies,
// another instance takes over within LEADER_TTL_MS. Single-instance (no
// Redis) is trivially always the leader.
const LEADER_TTL_MS = 5_000;
const LEADER_HEARTBEAT_MS = 2_000;
let amLeader = !clusterEnabled;
async function leaderHeartbeat() {
  amLeader = await acquireOrRenewLeader("matchmaker", LEADER_TTL_MS);
}

function eloBandFor(waitMs) {
  if (waitMs < BAND_TIER_1_MS) return BAND_TIER_1_ELO;
  if (waitMs < BAND_TIER_2_MS) return BAND_TIER_2_ELO;
  return Infinity;
}

async function enqueue(socketId) {
  const c = conns.get(socketId);
  if (!c || c.status !== "idle") return;
  c.status = "queued";
  // Stamp wait-start so band-widening is deterministic. Elo is cached
  // here too: it can't change while you're in the queue (you're not
  // playing), so reading it once avoids a per-tick DB read per candidate.
  c.queuedAt = Date.now();
  c.eloAtQueue = ((await getPlayer(c.player.id)) || c.player).elo;
  // After the await, the player might have disconnected — bail rather
  // than leaving a dead entry in the queue.
  if (!conns.has(socketId) || c.status !== "queued") return;
  await queueAdd({
    socketId,
    playerId: c.player.id,
    instanceId: INSTANCE_ID,
    queuedAt: c.queuedAt,
    eloAtQueue: c.eloAtQueue,
  });
  c.socket.emit("queued");
  // Nudge the matchmaker; no-op unless we're the leader (otherwise the
  // leader's periodic tick picks it up within MATCHMAKER_TICK_MS).
  tryMatch();
}

async function dequeue(socketId) {
  await queueRemove(socketId);
  const c = conns.get(socketId);
  if (c && c.status === "queued") {
    c.status = "idle";
    c.queuedAt = null;
    c.socket.emit("queueCancelled");
  }
}

// Re-entrancy guard: runMatchmaker awaits DB reads inside createMatch, so a
// 1s tick could overlap a slow run. Serialize.
let matchmaking = false;

// Leader-gated entry point. Called on the periodic tick AND opportunistically
// from enqueue. Bails immediately on non-leader instances.
async function tryMatch() {
  if (!amLeader) return;
  if (matchmaking) return;
  matchmaking = true;
  try {
    await runMatchmaker();
  } catch (err) {
    console.error("runMatchmaker:", err.message);
  } finally {
    matchmaking = false;
  }
}

// One scan of the SHARED queue (read once from Redis), pairing the
// longest-waiting player whose band finds a partner; repeat until no more
// pairs form. Within a band we PREFER a same-instance partner (keeps the
// match's I/O in-process) and only reach across instances when there's no
// local partner in range. Pairs are claimed atomically so a cancel/other
// tick can't double-book; an unclaimable pair is skipped this scan.
async function runMatchmaker() {
  let entries = await queueAll();
  // Longest waiting first — priority to people who've waited the most.
  entries.sort((a, b) => a.queuedAt - b.queuedAt);
  const skip = new Set();

  while (true) {
    const live = entries.filter((e) => !skip.has(e.socketId));
    if (live.length === 0) return;
    const a = live[0];
    const aWait = Date.now() - a.queuedAt;
    const band = eloBandFor(aWait);

    // Longest-waiting viable partner within a's band; prefer same instance.
    let best = null;
    let bestRemote = null;
    for (let i = 1; i < live.length; i++) {
      const b = live[i];
      if (Math.abs(a.eloAtQueue - b.eloAtQueue) > band) continue;
      if (b.instanceId === a.instanceId) {
        best = b; // same-instance + already oldest-first = our pick
        break;
      }
      if (!bestRemote) bestRemote = b; // oldest in-band cross-instance partner
    }
    best = best || bestRemote;

    if (best) {
      const claimed = await queueClaimPair(a.socketId, best.socketId);
      if (claimed) {
        await spawnMatch(claimed[0], claimed[1]);
        entries = entries.filter(
          (e) => e.socketId !== a.socketId && e.socketId !== best.socketId
        );
      } else {
        // One of them vanished (cancel/disconnect) between read and claim.
        skip.add(a.socketId);
        skip.add(best.socketId);
      }
      continue;
    }

    // No human partner. If a crossed the bot threshold, give them a bot.
    if (aWait >= BOT_WAIT_MS) {
      const claimed = await queueClaimOne(a.socketId);
      if (claimed) {
        await spawnBotMatch(claimed);
        entries = entries.filter((e) => e.socketId !== a.socketId);
      } else {
        skip.add(a.socketId);
      }
      continue;
    }

    // a can't pair yet (band too narrow + not bot-eligible). Skip them for
    // the rest of this scan; they widen on a later tick.
    skip.add(a.socketId);
  }
}

// Turn a claimed pair of queue entries into a live match. The match is OWNED
// by aEntry's instance (so at least one player is local to the owner). If
// that's us, build it here; otherwise hand off to the owner instance. The
// partner may be local or a remote member (Phase 4d).
async function spawnMatch(aEntry, bEntry) {
  if (!isLocalInstance(aEntry.instanceId)) {
    await publishToInstance(aEntry.instanceId, {
      type: "spawnMatch",
      a: aEntry,
      b: bEntry,
    });
    return;
  }
  const aConn = conns.get(aEntry.socketId);
  if (!aConn || aConn.status !== "queued") {
    // Owner's player already gone — try to keep the partner queued.
    return requeueEntry(bEntry);
  }
  const bConn = isLocalInstance(bEntry.instanceId)
    ? conns.get(bEntry.socketId)
    : makeRemoteConn(bEntry);
  if (!bConn || (isLocalInstance(bEntry.instanceId) && bConn.status !== "queued")) {
    return requeueEntry(aEntry);
  }
  await createMatch(aConn, bConn);
}

async function spawnBotMatch(entry) {
  if (!isLocalInstance(entry.instanceId)) {
    await publishToInstance(entry.instanceId, { type: "spawnBot", entry });
    return;
  }
  const c = conns.get(entry.socketId);
  if (!c || c.status !== "queued") return;
  await createMatch(c, await makeBotConn(c));
}

// Put a still-connected player back in the pool (used when a pairing falls
// through because the other side vanished). Routed to their instance.
async function requeueEntry(entry) {
  if (!isLocalInstance(entry.instanceId)) {
    await publishToInstance(entry.instanceId, { type: "requeue", entry });
    return;
  }
  const c = conns.get(entry.socketId);
  if (c && c.status === "queued") await queueAdd(entry);
}

// Build a stand-in conn for a player connected to ANOTHER instance so the
// owner's match.members can hold them like any other member. The proxy
// socket routes ALL server->client traffic through the Socket.IO Redis
// adapter, which delivers to whichever instance actually holds the socket:
//   - emit            -> io.to(socketId)         (targeted, cross-instance)
//   - emit + ack      -> io.to(socketId).timeout (broadcast-ack form)
//   - to(room).emit   -> io.to(room).except(self) ("everyone but me")
//   - join/leave      -> io.in(socketId).socketsJoin/Leave (cross-instance)
// Incoming events from this player are forwarded to us by their instance
// (see the cluster message dispatcher). player carries only id; createMatch
// refreshes the full row from Postgres just like a local member.
function makeRemoteSocket(sid) {
  return {
    id: sid,
    emit: (event, payload) => io.to(sid).emit(event, payload),
    join: (room) => io.in(sid).socketsJoin(room),
    leave: (room) => io.in(sid).socketsLeave(room),
    to: (room) => ({
      emit: (event, payload) => io.to(room).except(sid).emit(event, payload),
    }),
    // Mirror socket.timeout(ms).emit(ev, payload, cb). Broadcast-ack delivers
    // (err, responses[]) — collapse to cb(err) so emitWithAckRetry's retry
    // logic (which only inspects err) works unchanged.
    timeout: (ms) => ({
      emit: (event, payload, cb) =>
        io
          .to(sid)
          .timeout(ms)
          .emit(event, payload, (err) => cb && cb(err)),
    }),
  };
}

function makeRemoteConn(entry) {
  return {
    socket: makeRemoteSocket(entry.socketId),
    player: { id: entry.playerId },
    status: "match",
    matchId: null,
    isBot: false,
    isRemote: true,
    remoteInstance: entry.instanceId,
  };
}

// Release a member back to idle when a match ends/teardown. For a LOCAL
// member we reset its conn (and optionally requeue). For a REMOTE member we
// can't touch its real conn (lives on another instance) — tell that instance
// to do it via the cluster bus. Bots have no state to release.
function memberIdle(c, { requeue = false } = {}) {
  if (!c || c.isBot) return;
  // We're the owner here, so we hold this player's match-registry entry —
  // clear it as they leave (matchId-scoped so we don't clobber a new match).
  if (c.player?.id) playerMatchClear(c.player.id, c.matchId);
  if (c.isRemote) {
    publishToInstance(c.remoteInstance, {
      type: "matchUnbind",
      socketId: c.socket.id,
      requeue,
    });
    return;
  }
  c.status = "idle";
  c.matchId = null;
  // NOTE: deliberately keep c.opponentId so you can still report a player who
  // left/disconnected while you're parked on the result screen. It's
  // overwritten when your next match starts (createMatch).
  if (requeue) enqueue(c.socket.id);
}

// ---------- Match lifecycle ----------
async function createMatch(a, b) {
  const id = crypto.randomUUID();
  const match = {
    id,
    // This instance owns the match: it holds the timers + authoritative game
    // state. A member may be local, a bot, or a remote proxy (another
    // instance's player) — see makeRemoteConn.
    ownerInstance: INSTANCE_ID,
    members: [a, b], // connection contexts (one may be a bot)
    bot: [a, b].find((m) => m.isBot) || null,
    state: "preparing", // preparing | countdown | playing | result | rematch
    round: 0,
    opening: null,
    popularity: null,
    correctAnimeId: null,
    durationMs: null,
    reported: new Map(), // socketId -> media ms
    startedAt: null,
    timers: {},
    rematchVotes: new Map(), // socketId -> bool
  };
  matches.set(id, match);

  for (const c of match.members) {
    // Members were already claimed out of the shared queue by the matchmaker
    // (or were never queued, for invite matches); nothing to remove here.
    c.status = "match";
    c.matchId = id;
    // Who this player can report (their opponent). Stable across the match.
    const other = match.members.find((x) => x !== c);
    c.opponentId = other?.player?.id || null;
    c.socket.join(id);
    if (c.isRemote) {
      // Tell the member's instance it's now in our match so it forwards the
      // player's in-match events here and tracks their lobby state.
      publishToInstance(c.remoteInstance, {
        type: "matchBind",
        socketId: c.socket.id,
        matchId: id,
        ownerInstance: INSTANCE_ID,
        opponentPlayerId: other?.player?.id || null,
      });
    }
    // conn.player is only set at auth, never after applyMatchResult — re-read
    // so matchFound's `you` reflects Elo earned earlier this session.
    if (!c.isBot) c.player = (await getPlayer(c.player.id)) || c.player;
    // Record where this player's live match runs so a reconnect (even to a
    // different instance) can find it. We own this match.
    if (!c.isBot) playerMatchSet(c.player.id, id, INSTANCE_ID);
  }
  const [pa, pb] = match.members;
  // `polite` is the WebRTC perfect-negotiation tiebreaker — exactly one peer
  // is polite so simultaneous offers can't deadlock.
  pa.socket.emit("matchFound", {
    you: publicPlayer(pa.player),
    opponent: publicPlayer(pb.player),
    polite: false,
  });
  pb.socket.emit("matchFound", {
    you: publicPlayer(pb.player),
    opponent: publicPlayer(pa.player),
    polite: true,
  });

  startRound(match);
}

async function startRound(match) {
  match.state = "preparing";
  match.round += 1;
  match.opening = null;
  match.correctAnimeId = null;
  match.altLinksP = null; // lazily-fetched fallback video links (this round)
  match.accepted = [];
  match.franchise = null;
  match.dub = null;
  match.durationMs = null;
  match.startedAt = null;
  match.reported.clear();
  match.rematchVotes.clear();
  clearTimers(match);

  // FIFO matchmaking ignores Elo, but the players' AVERAGE Elo decides how
  // obscure the opening is: low avg → popular/easy, high avg → deep cut.
  let sumElo = 0;
  for (const c of match.members) sumElo += (await freshSnapshot(c)).eloRaw;
  const avgElo = sumElo / match.members.length;
  // freshSnapshot above awaited DB reads; if the match was torn down
  // (e.g. both players disconnected during a slow round-pick), bail.
  if (!matches.has(match.id)) return;

  let opening;
  try {
    opening = await pickOpeningForElo(avgElo);
  } catch (err) {
    console.error("pickOpeningForElo:", err.message);
    io.to(match.id).emit("errorMsg", {
      message: "Couldn't load an opening from AnimeThemes. Try again.",
    });
    dissolveMatch(match, { requeue: true });
    return;
  }
  if (!matches.has(match.id)) return; // dissolved while fetching

  match.opening = opening;
  match.correctAnimeId = Number(opening.anime.id);
  match.accepted = opening.accepted || [];
  match.franchise = opening.franchise || null;
  match.dub = opening.dub || null; // {label,key} when playing an English dub
  match.popularity = opening.popularity;
  console.log(
    `[match ${match.id.slice(0, 8)}] avgElo=${Math.round(avgElo)} ` +
      `target=${opening.targetFactor} chosen=${opening.chosenFactor} ` +
      `"${opening.anime.name}"`
  );
  if (!matches.has(match.id)) return;

  io.to(match.id).emit("round:prepare", {
    round: match.round,
    videoUrl: opening.video.link,
    audioUrl: opening.audioUrl || null,
    dub: match.dub?.label || null,
  });

  // Eagerly resolve the alt-list (cached after the first call per
  // anime+theme combo) and push it to every client in the match as a
  // separate event. The client uses it for INSTANT, server-round-trip-
  // free fallback when a video/audio source fails. We don't block
  // round:prepare on it — clients can start buffering the primary
  // immediately; the alt-list arrives whenever AnimeThemes responds
  // (usually a cache hit = same tick).
  match.altLinksP = getCachedThemeMediaLinks(
    opening?.anime?.slug,
    opening?.theme?.slug
  );
  match.altLinksP.then((list) => {
    if (!matches.has(match.id)) return; // match ended while we waited
    io.to(match.id).emit("round:altList", { list: list || [] });
  });

  // Give clients a window to buffer + report media length, then start.
  match.timers.report = setTimeout(
    () => beginCountdown(match),
    DURATION_REPORT_WAIT_MS
  );
}

function onMediaDuration(match, socketId, ms) {
  if (!match || match.state !== "preparing") return;
  const v = Number(ms);
  if (Number.isFinite(v) && v > 0) match.reported.set(socketId, v);
  // Once every HUMAN has reported, start (a bot never reports).
  const humans = match.members.filter((m) => !m.isBot).length;
  if (match.reported.size >= humans) {
    clearTimeout(match.timers.report);
    beginCountdown(match);
  }
}

function beginCountdown(match) {
  if (!matches.has(match.id) || match.state !== "preparing") return;
  clearTimeout(match.timers.report);

  const reported = [...match.reported.values()];
  // Trust the SHORTER reported length (a client can't extend its own clock),
  // clamped to a sane window.
  const base = reported.length ? Math.min(...reported) : DURATION_FALLBACK_MS;
  match.durationMs = Math.max(
    DURATION_MIN_MS,
    Math.min(DURATION_MAX_MS, Math.round(base))
  );

  match.state = "countdown";
  // Track when countdown started so reconnect-resume can compute the
  // remaining countdown for a player who comes back mid-3-2-1.
  match.countdownStartedAt = Date.now();
  io.to(match.id).emit("round:start", {
    round: match.round,
    countdownMs: COUNTDOWN_MS,
    durationMs: match.durationMs,
  });

  match.timers.start = setTimeout(() => {
    if (!matches.has(match.id) || match.state !== "countdown") return;
    match.state = "playing";
    match.startedAt = Date.now();
    match.timers.end = setTimeout(
      () =>
        onRoundTimeout(match).catch((err) =>
          console.error("onRoundTimeout:", err.message)
        ),
      match.durationMs
    );
    if (match.bot) scheduleBotPlay(match);
  }, COUNTDOWN_MS);
}

async function handleGuess(match, conn, { animeId, guessText } = {}) {
  // If the round isn't actively playing on the server but the client still
  // thinks it is (likely a lost round:end during the video-alternate dance),
  // tell the client to resync so the UI doesn't stay wedged in an
  // un-submittable battle screen. Without this, guesses silently disappear.
  if (!match) return;
  if (match.state !== "playing") {
    conn.socket.emit("match:resync", { state: match.state });
    return;
  }
  // Correct if they picked the exact entry from autocomplete, OR typed any
  // accepted franchise name (English / Japanese / acronym / dub / any
  // season or movie title of the franchise).
  const correct =
    (animeId != null && Number(animeId) === match.correctAnimeId) ||
    isCorrect(guessText, match.accepted);

  if (!correct) {
    // Unlimited guesses (per spec) — just inform both sides for tension.
    conn.socket.emit("guess:result", { correct: false });
    conn.socket.to(match.id).emit("opponent:guessed", { correct: false });
    return;
  }
  await settleWin(match, conn);
}

async function freshSnapshot(conn) {
  // Re-read so Elo reflects earlier rounds played within this same match.
  return snapshot((await getPlayer(conn.player.id)) || conn.player);
}

async function settleWin(match, winnerConn) {
  match.state = "result";
  clearTimers(match);

  const loserConn = match.members.find((c) => c !== winnerConn);
  const w = await freshSnapshot(winnerConn);
  if (!matches.has(match.id)) return;
  const l = await freshSnapshot(loserConn);
  if (!matches.has(match.id)) return;
  const pop = match.popularity || { factor: 0.5 };
  // disconnectForfeit is set for both voluntary forfeits and real disconnects.
  // voluntary is set ONLY when the loser hit the Forfeit button — in that
  // case the winner gains 0 Elo (kills the wait-out farm meta) but the
  // forfeiter still takes their normal forfeit-scaled loss.
  const r = resolveWin(w.eloRaw, l.eloRaw, pop.factor, {
    forfeit: !!match.disconnectForfeit,
    voluntary: !!match.voluntary,
  });

  // Outcome label: voluntary forfeit gets its own value so the recent-matches
  // history can render it differently (NC for the non-forfeit player, LOSS
  // for the forfeiter) from a real network disconnect.
  const outcomeLabel = match.voluntary
    ? "forfeit"
    : match.disconnectForfeit
    ? "disconnect"
    : "win";

  await applyMatchResult({
    outcome: outcomeLabel,
    animeName: match.opening.anime.name,
    malId: match.opening.malId,
    durationMs: match.startedAt ? Date.now() - match.startedAt : 0,
    winner: {
      id: w.id, nickname: w.nickname, eloBefore: w.eloRaw, eloAfter: r.winnerAfter,
      wins: w.wins, losses: w.losses, draws: w.draws,
    },
    loser: {
      id: l.id, nickname: l.nickname, eloBefore: l.eloRaw, eloAfter: r.loserAfter,
      wins: l.wins, losses: l.losses, draws: l.draws,
    },
  });
  if (!matches.has(match.id)) return;

  // A bot has no DB row, so freshSnapshot() reads its in-memory player —
  // persist its new rating there so it actually gains/loses across rematches
  // and the opponent badge reflects it (humans persist via applyMatchResult).
  for (const m of match.members) {
    if (!m.isBot) continue;
    m.player.elo = m === winnerConn ? r.winnerAfter : r.loserAfter;
  }

  emitRoundEnd(match, {
    outcome: outcomeLabel,
    // True only when the loser pressed Forfeit; false for a real network
    // disconnect. Kept on the wire so existing Kuro/result-panel logic
    // that checks `voluntary` keeps working alongside the new outcome label.
    voluntary: !!match.voluntary,
    [winnerConn.socket.id]: {
      youWon: true,
      eloBefore: Math.round(w.eloRaw),
      eloAfter: Math.round(r.winnerAfter),
      delta: r.winnerDelta,
      oppElo: Math.round(r.loserAfter), // opponent's new rating
    },
    [loserConn.socket.id]: {
      youWon: false,
      eloBefore: Math.round(l.eloRaw),
      eloAfter: Math.round(r.loserAfter),
      delta: r.loserDelta,
      oppElo: Math.round(r.winnerAfter),
    },
  });
  beginRematch(match);
}

async function onRoundTimeout(match) {
  if (!matches.has(match.id) || match.state !== "playing") return;
  match.state = "result";
  clearTimers(match);

  const [ca, cb] = match.members;
  const a = await freshSnapshot(ca);
  if (!matches.has(match.id)) return;
  const b = await freshSnapshot(cb);
  if (!matches.has(match.id)) return;
  const r = resolveTimeout(a.eloRaw, b.eloRaw, match.popularity?.factor);

  await applyMatchResult({
    outcome: "timeout",
    animeName: match.opening.anime.name,
    malId: match.opening.malId,
    durationMs: match.durationMs,
    a: { id: a.id, nickname: a.nickname, eloBefore: a.eloRaw, eloAfter: r.aAfter, wins: a.wins, losses: a.losses, draws: a.draws },
    b: { id: b.id, nickname: b.nickname, eloBefore: b.eloRaw, eloAfter: r.bAfter, wins: b.wins, losses: b.losses, draws: b.draws },
  });
  if (!matches.has(match.id)) return;

  for (const m of match.members) {
    if (!m.isBot) continue;
    m.player.elo = m === ca ? r.aAfter : r.bAfter;
  }

  emitRoundEnd(match, {
    outcome: "timeout",
    [ca.socket.id]: {
      youWon: false,
      eloBefore: Math.round(a.eloRaw),
      eloAfter: Math.round(r.aAfter),
      delta: r.aDelta,
      oppElo: Math.round(r.bAfter),
    },
    [cb.socket.id]: {
      youWon: false,
      eloBefore: Math.round(b.eloRaw),
      eloAfter: Math.round(r.bAfter),
      delta: r.bDelta,
      oppElo: Math.round(r.aAfter),
    },
  });
  beginRematch(match);
}

function emitRoundEnd(match, perSocket) {
  const answer = {
    id: match.correctAnimeId,
    name: match.opening.anime.name,
    franchise: match.franchise,
    dub: match.dub?.label || null,
    year: match.opening.anime.year,
    song: match.opening.song?.title || null,
  };
  const pop = match.popularity || {};
  // Cache last round-end payload keyed by player.id so reconnect-resume
  // can hand the right one back to a returning player (socket.id changes
  // across reconnects; player.id is stable).
  match.lastResultByPlayer = match.lastResultByPlayer || {};
  for (const c of match.members) {
    const payload = {
      // Round number lets the client dedupe a retransmit — if it already
      // processed this round's end, the second one is a no-op.
      round: match.round,
      outcome: perSocket.outcome,
      voluntary: !!perSocket.voluntary,
      answer,
      popularity: {
        members: pop.members ?? null,
        score: pop.score ?? null,
        factor: pop.factor != null ? Math.round(pop.factor * 100) / 100 : null,
      },
      result: perSocket[c.socket.id],
    };
    if (c.player?.id) match.lastResultByPlayer[c.player.id] = payload;
    if (c.isBot) {
      // Bot's fake socket.emit is a noop; preserve the existing call so
      // the loop shape is unchanged. No ACK to wait for.
      c.socket.emit("round:end", payload);
    } else if (c.disconnected) {
      // Skip the ACK retry to a known-dead socket — the cached payload
      // above will be sent via match:resume when they reconnect.
      continue;
    } else {
      // CRITICAL EVENT: phase transition out of the live round. If this
      // is lost in flight (transient network blip, transport upgrade,
      // backgrounded tab), the client gets wedged on the playing UI
      // while the rematch flow continues server-side. Use a 500ms ACK
      // timeout and retry up to 2 more times (1.5s total) so a single
      // dropped packet recovers without user-visible damage. The client
      // dedupes on payload.round so a retransmit after the client has
      // already processed the first one is harmless.
      emitWithAckRetry(c.socket, "round:end", payload, 3);
    }
  }
}

// Rebind a previously-disconnected conn (still living in match.members)
// onto a new socket. Migrates per-socket-id state (vote, reported media
// length) and resumes the client via "match:resume".
function rebindAndResume(match, oldConn, newSocket) {
  const oldSocketId = oldConn.socket?.id || null;
  // The new socket already has its own placeholder conn in conns; drop it
  // and point newSocket.id → the OLD conn so all subsequent socket events
  // (guess, leaveMatch, etc.) hit the same conn that's in match.members.
  conns.delete(newSocket.id);
  conns.set(newSocket.id, oldConn);
  oldConn.socket = newSocket;
  oldConn.disconnected = false;
  oldConn.disconnectedAt = null;
  newSocket.join(match.id);

  // Migrate socket-id-keyed maps to the new socket.id.
  if (oldSocketId && match.rematchVotes.has(oldSocketId)) {
    const v = match.rematchVotes.get(oldSocketId);
    match.rematchVotes.delete(oldSocketId);
    match.rematchVotes.set(newSocket.id, v);
  }
  if (oldSocketId && match.reported.has(oldSocketId)) {
    const r = match.reported.get(oldSocketId);
    match.reported.delete(oldSocketId);
    match.reported.set(newSocket.id, r);
  }

  // Send authed + match:resume so the client knows who it is and what
  // state to render. Existing socket handlers (guess, vote, etc.) work
  // because newSocket.id now maps to the same conn. The opponent gets
  // NO notification — from their side the game has been continuing
  // normally; they don't need to know we ever left.
  newSocket.emit("authed", { player: publicPlayer(oldConn.player) });
  newSocket.emit("match:resume", buildResumePayload(match, oldConn));

  // If the match was waiting on this player to come back before tearing
  // down (e.g. opponent declined the rematch while we were gone), deliver
  // the queued opponent:gone now.
  if (match.pendingOpponentGone) {
    const reason = match.pendingOpponentGone;
    match.pendingOpponentGone = null;
    parkAfterOpponentGone(match, reason, [oldConn]);
  }
}

// Cross-instance variant of rebindAndResume: the disconnected member is a
// REMOTE proxy (this match's owner is us; the player reconnected to another
// instance). Re-point the proxy at the new socket id / instance, migrate the
// socket-id-keyed state, re-affirm the binding on the player's instance, and
// drive authed + match:resume back over the adapter.
function rebindRemoteAndResume(match, oldConn, newSocketId, newInstance) {
  const oldSocketId = oldConn.socket?.id || null;
  oldConn.socket = makeRemoteSocket(newSocketId);
  oldConn.remoteInstance = newInstance;
  oldConn.disconnected = false;
  oldConn.disconnectedAt = null;

  if (oldSocketId && match.rematchVotes.has(oldSocketId)) {
    match.rematchVotes.set(newSocketId, match.rematchVotes.get(oldSocketId));
    match.rematchVotes.delete(oldSocketId);
  }
  if (oldSocketId && match.reported.has(oldSocketId)) {
    match.reported.set(newSocketId, match.reported.get(oldSocketId));
    match.reported.delete(oldSocketId);
  }

  oldConn.socket.join(match.id);
  publishToInstance(newInstance, {
    type: "matchBind",
    socketId: newSocketId,
    matchId: match.id,
    ownerInstance: INSTANCE_ID,
  });
  oldConn.socket.emit("authed", { player: publicPlayer(oldConn.player) });
  oldConn.socket.emit("match:resume", buildResumePayload(match, oldConn));

  if (match.pendingOpponentGone) {
    const reason = match.pendingOpponentGone;
    match.pendingOpponentGone = null;
    parkAfterOpponentGone(match, reason, [oldConn]);
  }
}

function buildResumePayload(match, you) {
  const opponent = match.members.find((m) => m !== you);
  const now = Date.now();
  const countdownRemainingMs =
    match.state === "countdown" && match.countdownStartedAt
      ? Math.max(0, COUNTDOWN_MS - (now - match.countdownStartedAt))
      : null;
  const playingRemainingMs =
    match.state === "playing" && match.startedAt && match.durationMs
      ? Math.max(0, match.durationMs - (now - match.startedAt))
      : null;
  return {
    state: match.state,
    you: publicPlayer(you.player),
    opponent: publicPlayer(opponent?.player),
    round: match.round,
    opening: match.opening
      ? {
          videoUrl: match.opening.video?.link || null,
          audioUrl: match.opening.audioUrl || null,
          dub: match.dub?.label || null,
        }
      : null,
    durationMs: match.durationMs || null,
    countdownRemainingMs,
    playingRemainingMs,
    // Result + votes for resumes during the post-round screens.
    roundEnd:
      (match.state === "result" || match.state === "rematch") &&
      match.lastResultByPlayer
        ? match.lastResultByPlayer[you.player.id] || null
        : null,
    votes:
      match.state === "rematch"
        ? {
            you: match.rematchVotes.get(you.socket.id) ?? null,
            opponent: opponent
              ? match.rematchVotes.get(opponent.socket.id) ?? null
              : null,
          }
        : null,
  };
}

function emitWithAckRetry(socket, event, payload, attempts) {
  const tryOnce = (left) => {
    socket.timeout(500).emit(event, payload, (err) => {
      // err is set when no ACK arrived within the timeout window.
      // Retry until we've exhausted attempts; after that the client is
      // most likely disconnected, and the disconnect handler will clean
      // up the match independently.
      if (err && left > 1) tryOnce(left - 1);
    });
  };
  tryOnce(attempts);
}

// ---------- Rematch handshake ----------
function beginRematch(match) {
  match.state = "rematch";
  match.disconnectForfeit = false;
  match.voluntary = false;
  match.rematchVotes.clear();
  emitRematchState(match);
  // The bot decides 50/50 after a short, human-like delay (reusing the same
  // vote path: "no" dissolves like a real decline, "yes" needs the human too).
  if (match.bot) {
    match.timers.botVote = setTimeout(() => {
      if (matches.has(match.id) && match.state === "rematch")
        onRematchVote(match, match.bot, Math.random() < 0.5);
    }, 1200 + Math.random() * 2500);
  }
  match.timers.rematch = setTimeout(() => {
    // Nobody decided in time → end the match but keep each connected player
    // on the result screen; they re-queue when they choose to.
    parkAfterOpponentGone(match, "rematch_timeout", match.members.slice());
  }, REMATCH_TIMEOUT_MS);
}

function emitRematchState(match) {
  for (const c of match.members) {
    const other = match.members.find((m) => m !== c);
    c.socket.emit("rematch:state", {
      you: match.rematchVotes.get(c.socket.id) ?? null,
      opponent: match.rematchVotes.get(other?.socket.id) ?? null,
    });
  }
}

function onRematchVote(match, conn, yes) {
  if (!match || match.state !== "rematch") return;
  match.rematchVotes.set(conn.socket.id, !!yes);

  if (!yes) {
    const other = match.members.find((c) => c !== conn);
    clearTimers(match);
    matches.delete(match.id);
    // The decliner explicitly asked for a new opponent → honour that:
    // requeue them (PvP) or back to lobby (vs a bot).
    if (!conn.isBot) {
      conn.socket.leave(match.id);
      conn.socket.emit("match:over", { reason: "declined" });
      // Requeue a PvP decliner (find a new opponent); a bot decliner just
      // goes back to the lobby. memberIdle routes the requeue to the right
      // instance for a remote member.
      memberIdle(conn, { requeue: !match.bot });
    }
    // The other player didn't choose to leave → keep them parked on the
    // result screen with a manual "Find new opponent" button.
    parkAfterOpponentGone(match, "opponent_declined", [other]);
    return;
  }
  emitRematchState(match);
  const votes = match.members.map((c) => match.rematchVotes.get(c.socket.id));
  if (votes.every((v) => v === true)) {
    clearTimers(match);
    io.to(match.id).emit("rematch:accepted");
    startRound(match);
  }
}

// ---------- Teardown ----------
function clearTimers(match) {
  for (const t of Object.values(match.timers)) clearTimeout(t);
  match.timers = {};
}

// Dissolve a match. Players who didn't leave are put back in the queue so
// they can find a new random opponent.
function dissolveMatch(match, { requeue = false, reason } = {}, leaverId) {
  if (!matches.has(match.id)) return;
  clearTimers(match);
  matches.delete(match.id);

  for (const c of match.members) {
    if (c.isBot) continue; // bot has no socket/state to clean up
    c.socket.leave(match.id);
    if (c.socket.id === leaverId) {
      memberIdle(c);
      continue;
    }
    c.socket.emit("match:over", { reason: reason || "ended" });
    memberIdle(c, { requeue });
  }
}

// A client reported the opening won't play on their screen. The round can't
// be fair if only one side hears it and there's nothing we can do about a bad
// CDN/codec, so VOID the round — no Elo change (not the players' fault) — and
// drop straight into the normal rematch handshake so the SAME two players can
// choose to play each other again. Only valid before a round is decided;
// ignored on the result/vote screen (it already played).
async function abortUnplayable(match) {
  if (!matches.has(match.id)) return;
  if (!["preparing", "countdown", "playing"].includes(match.state)) return;
  if (!match.opening) return; // nothing to reveal yet — let it time out
  match.state = "result";
  clearTimers(match);

  const perSocket = { outcome: "unplayable" };
  const snaps = new Map();
  for (const c of match.members) snaps.set(c, await freshSnapshot(c));
  if (!matches.has(match.id)) return;
  for (const c of match.members) {
    const s = snaps.get(c);
    const other = match.members.find((m) => m !== c);
    perSocket[c.socket.id] = {
      youWon: false,
      eloBefore: Math.round(s.eloRaw),
      eloAfter: Math.round(s.eloRaw), // unchanged
      delta: 0,
      oppElo: Math.round((snaps.get(other) || s).eloRaw),
    };
  }
  emitRoundEnd(match, perSocket); // reveals the answer; no DB write
  for (const c of match.members)
    if (!c.isBot)
      c.socket.emit("errorMsg", {
        message: "That opening wouldn't play — round skipped (no Elo change).",
      });
  beginRematch(match);
}

// The opponent is gone (real disconnect, declined the rematch, or the rematch
// timed out) but THIS player is still connected. Don't yank them off the
// result screen: tear the match down once and leave each surviving human
// idle but NOT requeued. The client keeps the revealed opening playable and
// shows a "Find new opponent" button — they re-queue only when they choose.
//
// If a SURVIVOR is currently disconnected (e.g. they dropped wifi just as
// the opponent declined / timed out), we DON'T tear down — the match
// stays alive until they reconnect, at which point rebindAndResume
// delivers the queued opponent:gone notice. Otherwise they'd reconnect
// to a missing match and have no idea what happened.
function parkAfterOpponentGone(match, reason, survivors) {
  const waitingFor = survivors.find(
    (c) => c && !c.isBot && c.disconnected
  );
  if (waitingFor) {
    // Defer the teardown until the survivor reconnects — so they can
    // actually see the opponent:gone notice when they come back. To
    // avoid leaking a match if they never return, set a hard cap: after
    // 2 minutes we give up and dissolve. Past that point the disconnected
    // player will reconnect to an empty lobby and miss the notice.
    match.pendingOpponentGone = reason;
    clearTimeout(match.timers.deferredDissolve);
    match.timers.deferredDissolve = setTimeout(() => {
      if (!matches.has(match.id)) return;
      clearTimers(match);
      matches.delete(match.id);
    }, 2 * 60 * 1000);
    return;
  }

  if (matches.has(match.id)) {
    clearTimers(match);
    matches.delete(match.id);
  }
  for (const c of survivors) {
    if (!c || c.isBot) continue;
    c.socket.leave(match.id);
    c.socket.emit("opponent:gone", { reason });
    memberIdle(c);
  }
}

// A disconnect AFTER the round actually started (state "playing") is a
// forfeit — refresh/close-tab can't be a free escape from a losing round.
// A disconnect DURING the 3-2-1 countdown (or while still preparing) is a
// Disconnect during a match. Rules:
//
//   - state "preparing" with NO opening yet: genuine "couldn't get the
//     round set up" race window. Nobody has anything to forfeit from.
//     Cancel cleanly, no Elo.
//
//   - state "result" / "rematch": round already settled, no Elo penalty.
//     Survivor parked, leaver goes home.
//
//   - state "preparing"-with-opening / "countdown" / "playing": the round
//     KEEPS RUNNING. The disconnected player is marked .disconnected and
//     the match stays alive — they can reconnect anytime before the round
//     ends. If the round naturally ends while they're gone (opponent
//     guesses, timer expires), they get whatever result emerges. No
//     grace timer, no forfeit-by-disconnect-timeout — just "show up
//     before the round ends or eat the consequences."
function handleDisconnectDuringMatch(match, goneConn) {
  const other = match.members.find((c) => c !== goneConn);
  if (!other) {
    matches.delete(match.id);
    return;
  }

  if (match.state === "preparing" && !match.opening) {
    clearTimers(match);
    matches.delete(match.id);
    if (!other.isBot) {
      other.socket.leave(match.id);
      other.socket.emit("match:over", {
        reason: "opponent_disconnected_pre_round",
      });
      memberIdle(other);
    }
    return;
  }

  if (match.state === "result" || match.state === "rematch") {
    parkAfterOpponentGone(match, "opponent_left", [other]);
    return;
  }

  // In-match disconnect (preparing-with-opening, countdown, playing).
  // Mark them disconnected; the round continues exactly as before.
  // The opponent gets NO notification — from their side the game just
  // plays normally (their video keeps going, their input keeps working,
  // the RTC peer just stops producing media without the UI flagging it).
  // The disconnected player's job is to reconnect before the round ends;
  // if they don't, they eat whatever result naturally emerges (opponent
  // guess / timeout). No grace timer, no escape.
  goneConn.disconnected = true;
  goneConn.disconnectedAt = Date.now();

  if (other.disconnected) {
    // Both players are now gone. Nobody to receive results. Quietly
    // dissolve; no Elo since nothing was actually decided.
    clearTimers(match);
    matches.delete(match.id);
  }
}

// A voluntary mid-round forfeit (the "Forfeit"/leave button). Unlike a real
// disconnect, the player is still connected, so we do NOT tear the match
// down: the forfeiter just loses THIS round (opponent wins it, forfeit Elo
// applies), then both players enter the normal rematch handshake — so they
// can choose to play each other again.
async function voluntaryForfeit(match, leaverConn) {
  if (!matches.has(match.id)) return;
  const winner = match.members.find((c) => c !== leaverConn);
  if (!winner) return;

  // Forfeit (or Home-click) in ANY in-match phase costs Elo. The pre-round
  // "no Elo" carve-out only applies to GENUINE disconnects — clicking Home
  // is a voluntary action and is treated as forfeit even during buffering
  // or the 3-2-1 countdown. (The client also greys out the Home button
  // mid-match as a UX hint.)
  // Edge case: state === "preparing" before the opening is picked (~ms
  // race) — we can't settle Elo without round info, so cancel cleanly.
  if (match.state === "preparing" && !match.opening) {
    clearTimers(match);
    matches.delete(match.id);
    for (const c of match.members) {
      if (c.isBot) continue;
      c.socket.leave(match.id);
      c.socket.emit("match:over", { reason: "match_cancelled" });
      memberIdle(c);
    }
    return;
  }
  if (
    match.state !== "preparing" &&
    match.state !== "countdown" &&
    match.state !== "playing"
  ) return;

  match.disconnectForfeit = true; // result reads "You forfeited" / "…you win"
  match.voluntary = true;         // distinguishes from real network disconnect
  match.state = "playing";        // shape the window settleWin expects
  await settleWin(match, winner); // applies Elo, emits round:end, beginRematch
}

// ---------- Bot opponent ----------
const clamp01 = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

async function makeBotConn(humanConn) {
  const base = (await freshSnapshot(humanConn)).eloRaw;
  const elo = Math.max(
    100,
    Math.round(base + (Math.random() * 2 - 1) * BOT_ELO_JITTER)
  );
  const noop = () => {};
  return {
    socket: {
      id: "botsock:" + crypto.randomUUID(),
      emit: noop,
      join: noop,
      leave: noop,
      to: () => ({ emit: noop }),
    },
    player: {
      id: "bot:" + crypto.randomUUID(),
      nickname: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
      elo,
      wins: 0,
      losses: 0,
      draws: 0,
      // Default avatar (purple silhouette) so bots match real-player UI and
      // don't expose their bot-ness via a blank-pfp tell.
      avatar: "/default.png",
    },
    status: "match",
    matchId: null,
    isBot: true,
  };
}

// (Bot match-creation now lives inline in tryMatch — when a candidate
// crosses BOT_WAIT_MS without finding any human, the matchmaker tick
// pairs them with makeBotConn(c) directly. Keeping startBotMatch around
// as a separate helper would just be a one-line wrapper.)

// The bot "plays": with popularity-adjusted accuracy it submits a correct
// guess at a random moment; otherwise it stays quiet (and may fake a miss
// for tension). Bot rating ≈ the player's Elo, so the match is ranked but
// the swing is small either way.
function scheduleBotPlay(match) {
  const bot = match.bot;
  if (!bot || match.state !== "playing") return;
  const pop = match.popularity?.factor ?? 0.5;
  const accuracy = clamp01(
    BOT_BASE_ACCURACY + (0.5 - pop) * 0.5,
    0.15,
    0.9
  );
  const dur = match.durationMs || 90_000;
  if (Math.random() < accuracy) {
    const delay = 2500 + Math.random() * (dur * 0.85 - 2500);
    match.timers.bot = setTimeout(() => {
      if (matches.has(match.id) && match.state === "playing")
        settleWin(match, bot).catch((err) =>
          console.error("bot settleWin:", err.message)
        );
    }, Math.max(2000, delay));
  } else if (Math.random() < 0.6) {
    const delay = 3000 + Math.random() * (dur * 0.7);
    match.timers.bot = setTimeout(() => {
      if (matches.has(match.id) && match.state === "playing")
        for (const m of match.members)
          if (!m.isBot) m.socket.emit("opponent:guessed", { correct: false });
    }, delay);
  }
}

// ---------- Invite (private friend match) ----------
async function genInviteCode() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from(
      { length: 6 },
      () => A[Math.floor(Math.random() * A.length)]
    ).join("");
  } while (await inviteExists(code));
  return code;
}

// Remove whatever invite this host created and clear their local lobby
// state. The host socket is always local to whichever instance created the
// invite, so the conn-status reset stays in-process.
async function removeInvitesBy(socketId) {
  await inviteRemoveByHost(socketId);
  const c = conns.get(socketId);
  if (c && c.status === "inviting") {
    c.status = "idle";
    c.inviteCode = null;
  }
}

// Redis expires invite keys for us (INVITE_TTL_S). This sweep only handles
// the UX side: a host still parked on the invite screen after their code
// lapsed gets told so the lobby resets. We check each locally-connected
// "inviting" host against the store; in the no-Redis fallback inviteExists
// applies the same TTL by createdAt. Each instance sweeps its own hosts.
setInterval(async () => {
  for (const c of conns.values()) {
    if (c.status !== "inviting" || !c.inviteCode) continue;
    try {
      if (!(await inviteExists(c.inviteCode))) {
        c.status = "idle";
        c.inviteCode = null;
        c.socket.emit("inviteExpired");
      }
    } catch {
      /* transient — next sweep retries */
    }
  }
}, 60_000).unref?.();

// Cross-instance invite join: the host's socket lives on another instance, so
// we can't call createMatch() locally. Implemented in Phase 4d (the host
// instance owns the match; this joiner becomes a remote member). Placeholder
// host is local. Hands off to the host's instance, which owns the match and
// holds this joiner as a remote member.
async function joinRemoteInvite(rec, joinerConn) {
  await publishToInstance(rec.hostInstance, {
    type: "spawnInvite",
    hostSocketId: rec.hostSocketId,
    joiner: {
      socketId: joinerConn.socket.id,
      playerId: joinerConn.player.id,
      instanceId: INSTANCE_ID,
    },
  });
}

// ---------- In-match events (shared by local sockets + forwarded) ----------
// When a player is on a DIFFERENT instance than their match's owner, their
// in-match events land on their own instance, which forwards them here over
// the cluster bus. These take (match, conn) so the identical code path serves
// a local socket and a forwarded event; `conn` is whichever member object is
// in match.members (a real conn or a remote proxy).
function relayInMatch(match, conn, event, payload) {
  const other = match.members.find((x) => x !== conn);
  if (other) other.socket.emit(event, payload);
}

async function handleVideoFailed(match, conn, url) {
  // Also serve alternates during the RESULT replay so a failed result-page
  // video can swap locally — the round is already settled, nothing to void.
  if (!["preparing", "countdown", "playing", "result"].includes(match.state))
    return;
  const slug = match.opening?.anime?.slug;
  if (!slug)
    return conn.socket.emit("round:altVideo", { url: null, audioUrl: null });
  if (!match.altLinksP)
    match.altLinksP = getCachedThemeMediaLinks(slug, match.opening?.theme?.slug);
  let links = [];
  try {
    links = (await match.altLinksP) || [];
  } catch {
    links = [];
  }
  if (!matches.has(match.id)) return; // round/match ended while fetching
  // Find the failed entry by video link, then advance one; fall back to
  // "anything but the failed video" if the client reported an unknown URL.
  const i = links.findIndex((x) => x.video === url);
  const next =
    i >= 0 ? links[i + 1] : links.find((x) => x.video && x.video !== url);
  conn.socket.emit("round:altVideo", {
    url: next?.video || null,
    audioUrl: next?.audio || null,
  });
}

async function handleLeaveMatch(match, conn) {
  // Forfeit applies in every in-match phase; the result/vote screen just
  // sends the leaver home and parks the survivor. (See the leaveMatch socket
  // handler comment for the full rationale.)
  if (
    match.state === "playing" ||
    match.state === "countdown" ||
    match.state === "preparing"
  ) {
    await voluntaryForfeit(match, conn);
  } else {
    const other = match.members.find((x) => x !== conn);
    clearTimers(match);
    matches.delete(match.id);
    conn.socket.leave(match.id);
    conn.socket.emit("match:over", { reason: "you_left" });
    memberIdle(conn);
    parkAfterOpponentGone(match, "opponent_left", [other]);
  }
}

// Forward an in-match event to the instance that owns the match (used when a
// player's match object lives on another instance).
function forwardMatchEvent(conn, event, payload) {
  if (conn?.remoteMatch)
    publishToInstance(conn.remoteMatch.owner, {
      type: "matchEvent",
      matchId: conn.remoteMatch.matchId,
      socketId: conn.socket.id,
      event,
      payload,
    });
}

// Run a forwarded event against the owned match, as if it had arrived locally.
function dispatchForwardedEvent(match, conn, event, payload = {}) {
  switch (event) {
    case "guess":
      return handleGuess(match, conn, payload);
    case "rematchVote":
      return onRematchVote(match, conn, payload.yes);
    case "mediaDuration":
      return onMediaDuration(match, conn.socket.id, payload.ms);
    case "roundUnplayable":
      return abortUnplayable(match);
    case "round:videoFailed":
      return handleVideoFailed(match, conn, payload.url);
    case "rtc:signal":
      return relayInMatch(match, conn, "rtc:signal", payload);
    case "rtc:state":
      return relayInMatch(match, conn, "rtc:peerState", {
        cam: !!payload.cam,
        mic: !!payload.mic,
      });
    case "leaveMatch":
      return handleLeaveMatch(match, conn);
    case "forfeit":
      return voluntaryForfeit(match, conn);
    case "playerDisconnect":
      return handleDisconnectDuringMatch(match, conn);
  }
}

// ---------- Cluster message dispatch (cross-instance coordination) ----------
// A player's instance learns its socket is now in a remote match.
function onMatchBind({ socketId, matchId, ownerInstance, opponentPlayerId }) {
  const c = conns.get(socketId);
  if (!c) {
    // Player vanished before the bind landed — let the owner tear down.
    publishToInstance(ownerInstance, {
      type: "matchEvent",
      matchId,
      socketId,
      event: "playerDisconnect",
      payload: {},
    });
    return;
  }
  c.status = "match";
  c.matchId = matchId;
  c.remoteMatch = { matchId, owner: ownerInstance };
  c.opponentId = opponentPlayerId || null;
  c.socket.join(matchId); // fast local room join so broadcasts reach us
}

// The owner released this player from a remote match.
function onMatchUnbind({ socketId, requeue }) {
  const c = conns.get(socketId);
  if (!c) return;
  c.status = "idle";
  c.matchId = null;
  c.remoteMatch = null;
  // Keep c.opponentId so a parked survivor can still report a player who left
  // (overwritten when their next match starts).
  if (requeue) enqueue(socketId);
}

// We own the match; run a forwarded in-match event from a remote member.
function onForwardedMatchEvent({ matchId, socketId, event, payload }) {
  const m = matches.get(matchId);
  if (!m) return;
  const c = m.members.find((mc) => mc.socket.id === socketId);
  if (!c) return;
  Promise.resolve(dispatchForwardedEvent(m, c, event, payload)).catch((err) =>
    console.error("forwarded event", event + ":", err.message)
  );
}

// A player reconnected on another instance; we own their match. Re-point our
// remote proxy at the new socket and resume them. If the match is gone, tell
// their instance to fall back to a normal (fresh-lobby) auth.
function onRemoteReconnect({ playerId, matchId, socketId, instanceId }) {
  const m = matches.get(matchId);
  const oldConn = m
    ? m.members.find((mc) => mc.isRemote && mc.player?.id === playerId)
    : null;
  if (!m || !oldConn) {
    publishToInstance(instanceId, { type: "reconnectFailed", socketId });
    return;
  }
  rebindRemoteAndResume(m, oldConn, socketId, instanceId);
}

// A friend joined our host's invite from another instance.
async function onSpawnInvite({ hostSocketId, joiner }) {
  const host = conns.get(hostSocketId);
  if (!host || host.status !== "inviting") {
    publishToInstance(joiner.instanceId, {
      type: "inviteFailed",
      socketId: joiner.socketId,
    });
    return;
  }
  host.inviteCode = null;
  await createMatch(host, makeRemoteConn(joiner));
}

if (clusterEnabled) {
  onClusterMessage((msg) => {
    switch (msg.type) {
      case "spawnMatch":
        spawnMatch(msg.a, msg.b).catch((e) =>
          console.error("spawnMatch:", e.message)
        );
        break;
      case "spawnBot":
        spawnBotMatch(msg.entry).catch((e) =>
          console.error("spawnBot:", e.message)
        );
        break;
      case "requeue":
        requeueEntry(msg.entry).catch((e) =>
          console.error("requeue:", e.message)
        );
        break;
      case "spawnInvite":
        onSpawnInvite(msg).catch((e) =>
          console.error("spawnInvite:", e.message)
        );
        break;
      case "inviteFailed": {
        const c = conns.get(msg.socketId);
        if (c)
          c.socket.emit("inviteError", {
            message: "That invite link is invalid or expired.",
          });
        break;
      }
      case "matchBind":
        onMatchBind(msg);
        break;
      case "matchUnbind":
        onMatchUnbind(msg);
        break;
      case "matchEvent":
        onForwardedMatchEvent(msg);
        break;
      case "remoteReconnect":
        onRemoteReconnect(msg);
        break;
      case "reconnectFailed": {
        // Owner couldn't resume us — drop the optimistic remote-match state we
        // set in the auth handler and land in a normal fresh lobby.
        const c = conns.get(msg.socketId);
        if (c) {
          c.status = "idle";
          c.matchId = null;
          c.remoteMatch = null;
          if (c.player) c.socket.emit("authed", { player: publicPlayer(c.player) });
        }
        break;
      }
    }
  });
}

// ---------- Per-socket throttle ----------
// A single malicious socket could spam invite creation, joinInvite brute
// force, repeated round:videoFailed (each first call triggers an alt-list
// fetch), or auth attempts. Token-bucket per (socket, event): tokens
// refill at refillPerSec, capped at capacity. Drop overage silently —
// emitting a warning to the offender just helps them tune their flood.
function rateOk(conn, event, capacity, refillPerSec) {
  if (!conn) return false;
  conn.buckets = conn.buckets || {};
  const now = Date.now();
  let b = conn.buckets[event];
  if (!b) {
    b = { tokens: capacity, last: now };
    conn.buckets[event] = b;
  }
  b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 1000) * refillPerSec);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Real client IP behind Render's proxy. trust proxy is on for Express, but
// Socket.IO reads the raw socket, so parse X-Forwarded-For ourselves (first
// hop = the client). Used for report-based IP bans.
function clientIpOf(socket) {
  const xff = socket.handshake.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return socket.handshake.address || "";
}

// ---------- Socket wiring ----------
io.on("connection", (socket) => {
  conns.set(socket.id, {
    socket,
    player: null,
    status: "idle",
    matchId: null,
    buckets: {},
    ip: clientIpOf(socket),
  });

  // Account required: authenticate the socket with our session token
  // (obtained from POST /api/auth/google). No guest path.
  socket.on("auth", async ({ token } = {}) => {
    const c = conns.get(socket.id);
    if (!c) return;
    // Slow down token-guessing on auth: 5 attempts, refilling 1/min.
    if (!rateOk(c, "auth", 5, 1 / 60)) return;
    const session = verifySession(token);
    const row = session?.sub ? await getPlayer(session.sub) : null;
    if (!row) {
      socket.emit("authError", { message: "Please sign in again." });
      return;
    }
    c.player = row;
    // Banned IPs can't sign in to play. (Bans are by IP, shared across
    // instances; they auto-lift after the ban window.)
    if (await isIpBanned(c.ip)) {
      socket.emit("banned", { untilMs: await banRemainingMs(c.ip) });
      return;
    }
    // Record where this player is so other instances can find them (invite
    // joins, cross-instance reconnect) and so reports can resolve their IP.
    // No-op single-instance.
    setPresence(row.id, socket.id);
    setPlayerIp(row.id, c.ip);

    // Reconnect: is this player a member of an active match with
    // .disconnected=true? If so, rebind the existing conn (the one in
    // match.members, carrying all the per-round state) to this new
    // socket, then send "match:resume" so the client can rebuild the UI.
    // No grace timer — the round has been ticking the whole time; if
    // they reconnect before it ends they get to keep playing.
    for (const m of matches.values()) {
      const oldConn = m.members.find(
        (mc) => mc.disconnected && mc.player?.id === row.id
      );
      if (oldConn) {
        rebindAndResume(m, oldConn, socket);
        return;
      }
    }

    // Cross-instance resume: the player's live match may be owned by ANOTHER
    // instance (a cross-instance random pair or invite). Ask that instance to
    // re-point its remote member at this socket and drive the resume. With
    // sticky sessions this is rare, but without it a refresh mid cross-instance
    // match would lose the round.
    if (clusterEnabled) {
      const pm = await playerMatchGet(row.id);
      if (pm && !isLocalInstance(pm.owner)) {
        if (await instanceIsAlive(pm.owner)) {
          // Optimistically mark our conn as in that remote match so its
          // in-match events forward; the owner sends authed + match:resume.
          c.status = "match";
          c.matchId = pm.matchId;
          c.remoteMatch = { matchId: pm.matchId, owner: pm.owner };
          socket.join(pm.matchId);
          publishToInstance(pm.owner, {
            type: "remoteReconnect",
            playerId: row.id,
            matchId: pm.matchId,
            socketId: socket.id,
            instanceId: INSTANCE_ID,
          });
          return;
        }
        // Owner is dead → the match is unrecoverable; drop the stale pointer.
        playerMatchClear(row.id, pm.matchId);
      }
    }

    socket.emit("authed", { player: publicPlayer(row) });
  });

  // Set a custom display name (persists to the account).
  socket.on("setNickname", async ({ nickname } = {}) => {
    const c = conns.get(socket.id);
    if (!c?.player) {
      socket.emit("authError", { message: "Sign in first." });
      return;
    }
    const row = await setNickname(c.player.id, nickname);
    if (!row) {
      socket.emit("nicknameError", {
        message: "Name must be 2–24 characters.",
      });
      return;
    }
    c.player = row;
    socket.emit("profileUpdated", { player: publicPlayer(row) });
  });

  socket.on("queue", async () => {
    const c = conns.get(socket.id);
    if (!c?.player) {
      socket.emit("authError", { message: "Sign in to play." });
      return;
    }
    if (!rateOk(c, "queue", 10, 10 / 60)) return;
    if (await isIpBanned(c.ip)) {
      socket.emit("banned", { untilMs: await banRemainingMs(c.ip) });
      return;
    }
    if (c.status === "inviting") await removeInvitesBy(socket.id);
    if (c.status === "idle") await enqueue(socket.id);
  });

  socket.on("cancelQueue", async () => {
    const c = conns.get(socket.id);
    // Safety net: if we're already in a match (the client may have raced
    // matchFound vs. its own Home-click and sent cancelQueue from the
    // found-hold window), treat it as a forfeit instead of a no-op
    // dequeue. Without this, a player could escape Elo loss by clicking
    // Home in the moment between matchFound and their UI transitioning
    // to PREPARE. The client also sends leaveMatch directly in that
    // window, but this catches any path that doesn't.
    if (c?.matchId) {
      const m = matches.get(c.matchId);
      if (
        m &&
        (m.state === "preparing" ||
          m.state === "countdown" ||
          m.state === "playing")
      ) {
        await voluntaryForfeit(m, c);
        return;
      }
      // Remote-owned match: let the owner decide (voluntaryForfeit guards the
      // state, so a too-late click is a harmless no-op there).
      if (!m && c.remoteMatch) {
        forwardMatchEvent(c, "forfeit", {});
        return;
      }
    }
    await dequeue(socket.id);
  });

  // ---- Private friend match via invite link (ranked) ----
  socket.on("createInvite", async () => {
    const c = conns.get(socket.id);
    if (!c?.player) {
      socket.emit("authError", { message: "Sign in first." });
      return;
    }
    // 5 invites per minute is plenty; anything more is creating dead links
    // (each lives INVITE_TTL_MS = 15min).
    if (!rateOk(c, "createInvite", 5, 5 / 60)) return;
    if (c.status === "queued") await dequeue(socket.id);
    if (c.status !== "idle") {
      socket.emit("inviteError", { message: "Finish your current match first." });
      return;
    }
    await removeInvitesBy(socket.id);
    const code = await genInviteCode();
    await inviteCreate({
      code,
      hostSocketId: socket.id,
      hostPlayerId: c.player.id,
      hostInstance: INSTANCE_ID,
      createdAt: Date.now(),
    });
    // The conn may have gone away during the awaits; bail if so.
    if (!conns.has(socket.id)) {
      await inviteDelete(code);
      return;
    }
    c.status = "inviting";
    c.inviteCode = code;
    socket.emit("inviteCreated", { code });
  });

  socket.on("cancelInvite", async () => {
    await removeInvitesBy(socket.id);
    socket.emit("inviteCancelled");
  });

  socket.on("joinInvite", async ({ code } = {}) => {
    const c = conns.get(socket.id);
    if (!c?.player) {
      socket.emit("authError", { message: "Sign in to play." });
      return;
    }
    // Stops brute-force code discovery (30-char alphabet, 6 chars =
    // ~729M codes — 20 attempts/min/socket makes this infeasible).
    if (!rateOk(c, "joinInvite", 20, 20 / 60)) return;
    if (c.status === "queued") await dequeue(socket.id);
    if (c.status === "inviting") await removeInvitesBy(socket.id);
    if (c.status !== "idle") {
      socket.emit("inviteError", { message: "Finish your current match first." });
      return;
    }
    const upper = String(code || "").toUpperCase();
    const rec = await inviteGet(upper);
    if (!rec) {
      socket.emit("inviteError", {
        message: "That invite link is invalid or expired.",
      });
      return;
    }
    if (rec.hostSocketId === socket.id) {
      socket.emit("inviteError", { message: "You can't join your own invite." });
      return;
    }
    // Claim the code so a double-join can't pair the host twice.
    await inviteDelete(upper);

    if (isLocalInstance(rec.hostInstance)) {
      const host = conns.get(rec.hostSocketId);
      if (!host || host.status !== "inviting") {
        socket.emit("inviteError", {
          message: "That invite link is invalid or expired.",
        });
        return;
      }
      host.inviteCode = null;
      await createMatch(host, c);
    } else {
      // Host is on another instance — handed off to the cross-instance match
      // path (Phase 4d). In single-instance prod this branch never runs.
      await joinRemoteInvite(rec, c);
    }
  });

  // In-match events: handle locally if WE own the match, otherwise forward to
  // the owner instance (the player is on us, the match object is elsewhere).
  socket.on("mediaDuration", ({ ms } = {}) => {
    const c = conns.get(socket.id);
    const m = matches.get(c?.matchId);
    if (m) onMediaDuration(m, socket.id, ms);
    else forwardMatchEvent(c, "mediaDuration", { ms });
  });

  // The opening wouldn't play on this client → scrap the round, requeue both.
  socket.on("roundUnplayable", async () => {
    const c = conns.get(socket.id);
    const m = matches.get(c?.matchId);
    if (m) await abortUnplayable(m);
    else forwardMatchEvent(c, "roundUnplayable", {});
  });

  // A video link wouldn't play here — hand back the next encode of the SAME
  // OP slot (handleVideoFailed). Rate limiting stays at the edge (here) so a
  // flood is dropped on the player's own instance before any forwarding.
  socket.on("round:videoFailed", async ({ url } = {}) => {
    const c = conns.get(socket.id);
    // Each first call per round can trigger an AnimeThemes fetch (mitigated
    // by the alt-list cache, but defense in depth). 20-capacity, 0.5/s refill
    // lets a real codec-cascade through without throttling.
    if (!rateOk(c, "round:videoFailed", 20, 0.5)) return;
    const m = matches.get(c?.matchId);
    if (m) await handleVideoFailed(m, c, url);
    else forwardMatchEvent(c, "round:videoFailed", { url });
  });

  socket.on("guess", async ({ animeId, guessText } = {}) => {
    const c = conns.get(socket.id);
    // Fast typing during a heated round is legit (capacity 20, refill 5/s
    // = 300/min sustained). Anything above that is a flood — drop.
    if (!rateOk(c, "guess", 20, 5)) return;
    const m = matches.get(c?.matchId);
    if (m) await handleGuess(m, c, { animeId, guessText });
    else forwardMatchEvent(c, "guess", { animeId, guessText });
  });

  socket.on("rematchVote", ({ yes } = {}) => {
    const c = conns.get(socket.id);
    const m = matches.get(c?.matchId);
    if (m) onRematchVote(m, c, yes);
    else forwardMatchEvent(c, "rematchVote", { yes });
  });

  // ---- WebRTC signaling: relay verbatim to the other player in the match
  // (opt-in camera/mic). The server never inspects media, only forwards SDP
  // / ICE between exactly the two matched peers.
  socket.on("rtc:signal", (payload) => {
    const c = conns.get(socket.id);
    const m = matches.get(c?.matchId);
    if (m) relayInMatch(m, c, "rtc:signal", payload);
    else forwardMatchEvent(c, "rtc:signal", payload);
  });
  socket.on("rtc:state", ({ cam, mic } = {}) => {
    const c = conns.get(socket.id);
    const m = matches.get(c?.matchId);
    if (m) relayInMatch(m, c, "rtc:peerState", { cam: !!cam, mic: !!mic });
    else forwardMatchEvent(c, "rtc:state", { cam: !!cam, mic: !!mic });
  });

  // Voluntarily leave a match (e.g., user clicked "back to queue").
  socket.on("leaveMatch", async () => {
    const c = conns.get(socket.id);
    const m = matches.get(c?.matchId);
    if (m) await handleLeaveMatch(m, c);
    else forwardMatchEvent(c, "leaveMatch", {});
  });

  // Report the current opponent. The ban is by IP and needs REPORTS_TO_BAN
  // (3) DISTINCT reporters, so one person can't ban anyone solo. Reasons are
  // logged for the operator to review.
  socket.on("report", async ({ reason } = {}) => {
    const c = conns.get(socket.id);
    if (!c?.player) return;
    if (!rateOk(c, "report", 3, 3 / 60)) return;
    const oppId = c.opponentId;
    // No opponent, or a bot (no real IP) — ack silently so the dialog closes.
    if (!oppId || String(oppId).startsWith("bot:")) {
      socket.emit("report:ack");
      return;
    }
    const oppIp = await getPlayerIp(oppId);
    if (!oppIp) {
      socket.emit("report:ack");
      return;
    }
    const reporterKey = c.ip || c.player.id;
    const cleanReason = String(reason || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
    const res = await reportTarget(oppIp, reporterKey);
    console.log(
      `[report] by=${c.player.id} target=${oppId} reporters=${res.count} ` +
        `banned=${res.banned} reason=${JSON.stringify(cleanReason)}`
    );
    socket.emit("report:ack");
  });

  socket.on("disconnect", () => {
    const c = conns.get(socket.id);
    if (!c) return;
    if (c.player?.id) clearPresence(c.player.id, socket.id);
    dequeue(socket.id);
    removeInvitesBy(socket.id);
    const m = matches.get(c.matchId);
    if (m) handleDisconnectDuringMatch(m, c);
    // If our match is owned elsewhere, tell the owner this player dropped so
    // it can mark them disconnected (round keeps running; reconnect resumes).
    else if (c.remoteMatch) forwardMatchEvent(c, "playerDisconnect", {});
    conns.delete(socket.id);
  });
});

// Re-run matchmaking on a tick so Elo bands widen (and bot fallback
// fires) even when nobody is joining/leaving the queue. .unref() so
// this timer doesn't keep the process alive on shutdown. The .catch()
// swallows DB errors during a tick (e.g., Postgres blip) — next tick
// just retries.
setInterval(
  () => tryMatch().catch((err) => console.error("matchmaker tick:", err.message)),
  MATCHMAKER_TICK_MS
).unref?.();

// Elect/renew the single matchmaker leader. Run once at boot so there's a
// leader immediately, then on a heartbeat well inside LEADER_TTL_MS. No-op
// single-instance (amLeader is permanently true).
if (clusterEnabled) {
  leaderHeartbeat().catch((err) => console.error("leader heartbeat:", err.message));
  setInterval(
    () => leaderHeartbeat().catch((err) => console.error("leader heartbeat:", err.message)),
    LEADER_HEARTBEAT_MS
  ).unref?.();
}

// Cluster maintenance (no-op single-instance):
//  - heartbeat THIS instance's liveness key so peers know we're alive
//  - keep presence + match-registry keys alive for active local players
//  - detect a DEAD owner instance and release the players we have who were
//    paired into a match it was running (their opponent + match are gone)
if (clusterEnabled) {
  instanceHeartbeat().catch(() => {});
  setInterval(() => instanceHeartbeat().catch(() => {}), 5_000).unref?.();

  setInterval(() => {
    // presence + IP registry for everyone connected here
    for (const c of conns.values())
      if (c.player?.id) {
        refreshPresence(c.player.id);
        refreshPlayerIp(c.player.id);
      }
    // match-registry for members of matches WE own
    for (const m of matches.values())
      for (const mem of m.members)
        if (!mem.isBot && mem.player?.id) playerMatchRefresh(mem.player.id);
  }, 30_000).unref?.();

  setInterval(
    () => sweepDeadOwners().catch((err) => console.error("dead-owner sweep:", err.message)),
    7_000
  ).unref?.();
}

// Release any local players whose match is owned by an instance that has
// stopped heartbeating: that process is gone, taking the match object and
// (usually) their opponent with it. Dedupe the liveness check by owner.
async function sweepDeadOwners() {
  const owners = new Set();
  for (const c of conns.values())
    if (c.remoteMatch?.owner) owners.add(c.remoteMatch.owner);
  if (owners.size === 0) return;
  const dead = new Set();
  for (const o of owners) if (!(await instanceIsAlive(o))) dead.add(o);
  if (dead.size === 0) return;
  for (const c of conns.values()) {
    if (c.remoteMatch && dead.has(c.remoteMatch.owner)) {
      c.socket.leave(c.remoteMatch.matchId);
      c.socket.emit("match:over", { reason: "opponent_disconnected" });
      c.status = "idle";
      c.matchId = null;
      c.remoteMatch = null;
    }
  }
}

server.listen(PORT, () => {
  console.log(`Anime Opening Elo (multiplayer) listening on port ${PORT}`);
  // Fire-and-forget the ingester. .catch swallows DB blips so the listen
  // callback doesn't print an unhandled-rejection warning during cold boot.
  // Only the matchmaker leader actually ingests (shared Postgres pool), so 2+
  // instances don't double the AnimeThemes/Jikan API load. amLeader is always
  // true single-instance, so behavior there is unchanged.
  startIngester(() => amLeader).catch((err) =>
    console.error("startIngester:", err.message)
  );
});
