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
  getPlayerStats,
  DATA_DIR,
} from "./db.js";
import { searchAnime, getThemeVideoLinks } from "./animethemes.js";
import { isCorrect } from "./matching.js";
import { pickOpeningForElo } from "./selectOpening.js";
import { startIngester } from "./pool.js";
import { resolveWin, resolveTimeout } from "./elo.js";
import {
  GOOGLE_CLIENT_ID,
  loginWithGoogle,
  loginWithGoogleAccessToken,
  verifySession,
} from "./auth.js";

// ---------- Tunables ----------
const PORT = process.env.PORT || 5174;
const COUNTDOWN_MS = 3000; // 3-2-1 before audio, masks network jitter
const DURATION_MIN_MS = 10_000;
const DURATION_MAX_MS = 120_000; // OPs are ~90s; hard cap against a lying client
const DURATION_FALLBACK_MS = 90_000; // used if neither client reports in time
const DURATION_REPORT_WAIT_MS = 8_000;
const REMATCH_TIMEOUT_MS = 25_000;
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
app.use(cors());
app.use(express.json({ limit: "3mb" })); // headroom for base64 avatar uploads

// User-uploaded avatars live on the persistent disk and are served here.
const AVATAR_DIR = path.join(DATA_DIR, "avatars");
fs.mkdirSync(AVATAR_DIR, { recursive: true });
app.use(
  "/avatars",
  express.static(AVATAR_DIR, { maxAge: "1h", immutable: false })
);

// Pull the authenticated player from a Bearer session token (HTTP routes;
// the socket has its own auth). Returns the player row or null.
function authPlayer(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  const s = m && verifySession(m[1]);
  return s?.sub ? getPlayer(s.sub) : null;
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Public config the client needs to render the Google button.
app.get("/api/config", (_req, res) =>
  res.json({ googleClientId: GOOGLE_CLIENT_ID })
);

// Exchange a Google credential for our session token. Accepts either an ID
// token (legacy GIS button) or an OAuth access token (our custom button).
app.post("/api/auth/google", async (req, res) => {
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

// Autocomplete is the other per-keystroke AnimeThemes call, so cache it:
// short TTL + small LRU. Many users type the same prefixes ("nar", "one"…),
// so this collapses huge numbers of identical lookups into one.
const searchCache = new Map(); // q -> { at, results }
const SEARCH_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX = 500;

app.get("/api/search", async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const hit = searchCache.get(q);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) {
    return res.json({ results: hit.results });
  }
  try {
    const results = await searchAnime(q);
    searchCache.set(q, { at: Date.now(), results });
    if (searchCache.size > SEARCH_CACHE_MAX)
      searchCache.delete(searchCache.keys().next().value); // evict oldest
    res.json({ results });
  } catch (err) {
    console.error("search:", err.message);
    if (hit) return res.json({ results: hit.results }); // serve stale on error
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Seeded "ghost" players so the board looks lively and gives newcomers
// something to chase. They never enter matchmaking (no socket) — purely
// display, merged with real players and sorted by Elo.
const GHOST_PLAYERS = [
  // Records scale with Elo and are ALL winning: ~81% win rate at the top
  // tapering to ~56% at the bottom (still positive), more games up top.
  { id: "ghost:1", nickname: "KamiSpeed", elo: 4520, wins: 712, losses: 168 },
  { id: "ghost:2", nickname: "OPSniper", elo: 4390, wins: 680, losses: 176 },
  { id: "ghost:3", nickname: "SakuraBlitz", elo: 4260, wins: 651, losses: 184 },
  { id: "ghost:4", nickname: "ZeroFrame", elo: 4140, wins: 624, losses: 191 },
  { id: "ghost:5", nickname: "TitanEar", elo: 4020, wins: 598, losses: 198 },
  { id: "ghost:6", nickname: "RamenGod", elo: 3900, wins: 573, losses: 205 },
  { id: "ghost:7", nickname: "NanoDesu", elo: 3780, wins: 549, losses: 211 },
  { id: "ghost:8", nickname: "EdTune", elo: 3660, wins: 526, losses: 216 },
  { id: "ghost:9", nickname: "PlusUltra", elo: 3540, wins: 504, losses: 221 },
  { id: "ghost:10", nickname: "SenpaiFM", elo: 3420, wins: 483, losses: 225 },
  { id: "ghost:11", nickname: "GokuVibes", elo: 3300, wins: 462, losses: 229 },
  { id: "ghost:12", nickname: "MikuMain", elo: 3180, wins: 442, losses: 232 },
  { id: "ghost:13", nickname: "ChibiRush", elo: 3060, wins: 423, losses: 235 },
  { id: "ghost:14", nickname: "OtakuPrime", elo: 2950, wins: 405, losses: 237 },
  { id: "ghost:15", nickname: "LoFiLeaf", elo: 2840, wins: 388, losses: 239 },
  { id: "ghost:16", nickname: "AceQuill", elo: 2730, wins: 371, losses: 240 },
  { id: "ghost:17", nickname: "NovaBeat", elo: 2620, wins: 355, losses: 241 },
  { id: "ghost:18", nickname: "RoninLoop", elo: 2520, wins: 340, losses: 242 },
  { id: "ghost:19", nickname: "HikariWave", elo: 2420, wins: 326, losses: 242 },
  { id: "ghost:20", nickname: "DubLordX", elo: 2320, wins: 312, losses: 243 },
];

app.get("/api/leaderboard", (_req, res) => {
  const merged = [...leaderboard(50), ...GHOST_PLAYERS]
    .sort((a, b) => b.elo - a.elo)
    .slice(0, 20);
  res.json({ players: merged });
});

// Stats + recent matches for the signed-in player.
app.get("/api/me/stats", (req, res) => {
  const p = authPlayer(req);
  if (!p) return res.status(401).json({ error: "sign in" });
  res.json(getPlayerStats(p.id, 12));
});

// Upload a custom profile picture (base64 data URL in JSON).
const AVATAR_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
app.post("/api/me/avatar", (req, res) => {
  const p = authPlayer(req);
  if (!p) return res.status(401).json({ error: "sign in" });
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(
    String(req.body?.image || "")
  );
  if (!m) return res.status(400).json({ error: "expected png/jpeg/webp" });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 1_200_000)
    return res.status(413).json({ error: "image too large (max ~1.2MB)" });
  const ext = AVATAR_EXT[m[1]];
  // Single file per player; clean up other extensions so it doesn't grow.
  for (const e of Object.values(AVATAR_EXT)) {
    if (e !== ext)
      try {
        fs.unlinkSync(path.join(AVATAR_DIR, `${p.id}.${e}`));
      } catch {}
  }
  try {
    fs.writeFileSync(path.join(AVATAR_DIR, `${p.id}.${ext}`), buf);
  } catch (e) {
    return res.status(500).json({ error: "could not save image" });
  }
  const url = `/avatars/${p.id}.${ext}?t=${Date.now()}`;
  const updated = setCustomAvatar(p.id, url);
  res.json({ player: publicPlayer(updated) });
});

// ---------- Static frontend (production single-service) ----------
// In dev the client runs on Vite, which proxies /api and /socket.io here.
// In production this same process also serves the built React app, so the
// whole thing is one deploy on one origin (no CORS, no separate frontend).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.join(__dirname, "..", "client", "dist");
if (fs.existsSync(path.join(CLIENT_DIST, "index.html"))) {
  app.set("trust proxy", 1); // Render/Fly terminate TLS at a front proxy
  app.use(express.static(CLIENT_DIST));
  // SPA fallback: any non-API GET returns index.html. Socket.IO intercepts
  // /socket.io before Express, so it never reaches this.
  app.get(/^\/(?!api\/).*/, (_req, res) =>
    res.sendFile(path.join(CLIENT_DIST, "index.html"))
  );
  console.log("Serving built client from", CLIENT_DIST);
}

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

// ---------- Connection + match state ----------
// socket.id -> { socket, player, status: 'idle'|'queued'|'match', matchId }
const conns = new Map();
// FIFO matchmaking queue of socket ids.
let queue = [];
// matchId -> Match
const matches = new Map();
// invite code -> { hostSocketId, createdAt }
const invites = new Map();

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
function clearBotTimer(c) {
  if (c?.botTimer) {
    clearTimeout(c.botTimer);
    c.botTimer = null;
  }
}

function enqueue(socketId) {
  const c = conns.get(socketId);
  if (!c || c.status !== "idle") return;
  if (!queue.includes(socketId)) queue.push(socketId);
  c.status = "queued";
  c.socket.emit("queued");
  // No human within BOT_WAIT_MS → drop this player into a bot match.
  clearBotTimer(c);
  c.botTimer = setTimeout(() => startBotMatch(socketId), BOT_WAIT_MS);
  tryMatch();
}

function dequeue(socketId) {
  queue = queue.filter((id) => id !== socketId);
  const c = conns.get(socketId);
  clearBotTimer(c);
  if (c && c.status === "queued") {
    c.status = "idle";
    c.socket.emit("queueCancelled");
  }
}

function tryMatch() {
  while (queue.length >= 2) {
    const aId = queue.shift();
    const bId = queue.shift();
    const a = conns.get(aId);
    const b = conns.get(bId);
    // Skip stale entries (disconnected / already elsewhere).
    if (!a || a.status !== "queued") {
      if (b && b.status === "queued") queue.unshift(bId);
      continue;
    }
    if (!b || b.status !== "queued") {
      queue.unshift(aId);
      continue;
    }
    createMatch(a, b);
  }
}

// ---------- Match lifecycle ----------
function createMatch(a, b) {
  const id = crypto.randomUUID();
  const match = {
    id,
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
    clearBotTimer(c);
    queue = queue.filter((qid) => qid !== c.socket.id);
    c.status = "match";
    c.matchId = id;
    c.socket.join(id);
    // conn.player is only set at auth, never after applyMatchResult — re-read
    // so matchFound's `you` reflects Elo earned earlier this session.
    if (!c.isBot) c.player = getPlayer(c.player.id) || c.player;
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
  const avgElo =
    match.members.reduce((s, c) => s + freshSnapshot(c).eloRaw, 0) /
    match.members.length;

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
      () => onRoundTimeout(match),
      match.durationMs
    );
    if (match.bot) scheduleBotPlay(match);
  }, COUNTDOWN_MS);
}

function handleGuess(match, conn, { animeId, guessText } = {}) {
  if (!match || match.state !== "playing") return;
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
  settleWin(match, conn);
}

function freshSnapshot(conn) {
  // Re-read so Elo reflects earlier rounds played within this same match.
  return snapshot(getPlayer(conn.player.id) || conn.player);
}

function settleWin(match, winnerConn) {
  match.state = "result";
  clearTimers(match);

  const loserConn = match.members.find((c) => c !== winnerConn);
  const w = freshSnapshot(winnerConn);
  const l = freshSnapshot(loserConn);
  const pop = match.popularity || { factor: 0.5 };
  const r = resolveWin(w.eloRaw, l.eloRaw, pop.factor);

  applyMatchResult({
    outcome: match.disconnectForfeit ? "disconnect" : "win",
    animeName: match.opening.anime.name,
    malId: match.opening.malId,
    durationMs: match.startedAt ? Date.now() - match.startedAt : 0,
    winner: {
      id: w.id, eloBefore: w.eloRaw, eloAfter: r.winnerAfter,
      wins: w.wins, losses: w.losses, draws: w.draws,
    },
    loser: {
      id: l.id, eloBefore: l.eloRaw, eloAfter: r.loserAfter,
      wins: l.wins, losses: l.losses, draws: l.draws,
    },
  });

  // A bot has no DB row, so freshSnapshot() reads its in-memory player —
  // persist its new rating there so it actually gains/loses across rematches
  // and the opponent badge reflects it (humans persist via applyMatchResult).
  for (const m of match.members) {
    if (!m.isBot) continue;
    m.player.elo = m === winnerConn ? r.winnerAfter : r.loserAfter;
  }

  emitRoundEnd(match, {
    outcome: match.disconnectForfeit ? "disconnect" : "win",
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

function onRoundTimeout(match) {
  if (!matches.has(match.id) || match.state !== "playing") return;
  match.state = "result";
  clearTimers(match);

  const [ca, cb] = match.members;
  const a = freshSnapshot(ca);
  const b = freshSnapshot(cb);
  const r = resolveTimeout(a.eloRaw, b.eloRaw);

  applyMatchResult({
    outcome: "timeout",
    animeName: match.opening.anime.name,
    malId: match.opening.malId,
    durationMs: match.durationMs,
    a: { id: a.id, eloAfter: r.aAfter, wins: a.wins, losses: a.losses, draws: a.draws },
    b: { id: b.id, eloAfter: r.bAfter, wins: b.wins, losses: b.losses, draws: b.draws },
  });

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
  for (const c of match.members) {
    c.socket.emit("round:end", {
      outcome: perSocket.outcome,
      answer,
      popularity: {
        members: pop.members ?? null,
        score: pop.score ?? null,
        factor: pop.factor != null ? Math.round(pop.factor * 100) / 100 : null,
      },
      result: perSocket[c.socket.id],
    });
  }
}

// ---------- Rematch handshake ----------
function beginRematch(match) {
  match.state = "rematch";
  match.disconnectForfeit = false;
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
      conn.matchId = null;
      conn.status = "idle";
      conn.socket.emit("match:over", { reason: "declined" });
      if (!match.bot) enqueue(conn.socket.id);
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
    c.matchId = null;
    c.status = "idle";
    if (c.socket.id === leaverId) continue;
    c.socket.emit("match:over", { reason: reason || "ended" });
    if (requeue) enqueue(c.socket.id);
  }
}

// A client reported the opening won't play on their screen. The round can't
// be fair if only one side hears it and there's nothing we can do about a bad
// CDN/codec, so VOID the round — no Elo change (not the players' fault) — and
// drop straight into the normal rematch handshake so the SAME two players can
// choose to play each other again. Only valid before a round is decided;
// ignored on the result/vote screen (it already played).
function abortUnplayable(match) {
  if (!matches.has(match.id)) return;
  if (!["preparing", "countdown", "playing"].includes(match.state)) return;
  if (!match.opening) return; // nothing to reveal yet — let it time out
  match.state = "result";
  clearTimers(match);

  const perSocket = { outcome: "unplayable" };
  const snaps = new Map(match.members.map((c) => [c, freshSnapshot(c)]));
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
function parkAfterOpponentGone(match, reason, survivors) {
  if (matches.has(match.id)) {
    clearTimers(match);
    matches.delete(match.id);
  }
  for (const c of survivors) {
    if (!c || c.isBot) continue;
    c.socket.leave(match.id);
    c.matchId = null;
    c.status = "idle";
    c.socket.emit("opponent:gone", { reason });
  }
}

// A disconnect mid-play is a forfeit: the remaining player wins that round.
function handleDisconnectDuringMatch(match, goneConn) {
  const other = match.members.find((c) => c !== goneConn);
  if (!other) {
    matches.delete(match.id);
    return;
  }

  if (match.state === "playing" || match.state === "countdown") {
    match.disconnectForfeit = true;
    // Force the round end window into a state settleWin accepts.
    match.state = "playing";
    settleWin(match, other); // survivor wins this round and sees the result
    // ...and stays parked on that result (opening still playable) instead of
    // being thrown back into the queue. settleWin started a rematch
    // handshake; parkAfterOpponentGone tears it back down.
    parkAfterOpponentGone(match, "opponent_disconnected", [other]);
    return;
  }

  // Disconnect with a result already on screen (showing result / voting):
  // keep the survivor on it, no Elo change, no auto-requeue.
  if (match.state === "result" || match.state === "rematch") {
    parkAfterOpponentGone(match, "opponent_left", [other]);
    return;
  }

  // Disconnect while still preparing (nothing to watch yet): drop the
  // survivor to the lobby — no auto-requeue, they re-queue when ready.
  clearTimers(match);
  matches.delete(match.id);
  other.socket.leave(match.id);
  other.matchId = null;
  other.status = "idle";
  other.socket.emit("match:over", { reason: "opponent_left" });
}

// A voluntary mid-round forfeit (the "Forfeit"/leave button). Unlike a real
// disconnect, the player is still connected, so we do NOT tear the match
// down: the forfeiter just loses THIS round (opponent wins it, forfeit Elo
// applies), then both players enter the normal rematch handshake — so they
// can choose to play each other again.
function voluntaryForfeit(match, leaverConn) {
  if (!matches.has(match.id)) return;
  if (match.state !== "playing" && match.state !== "countdown") return;
  const winner = match.members.find((c) => c !== leaverConn);
  if (!winner) return;
  match.disconnectForfeit = true; // result reads "You forfeited" / "…you win"
  match.state = "playing";        // shape the window settleWin expects
  settleWin(match, winner);       // applies Elo, emits round:end, beginRematch
}

// ---------- Bot opponent ----------
const clamp01 = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function makeBotConn(humanConn) {
  const base = freshSnapshot(humanConn).eloRaw;
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
      avatar: null,
    },
    status: "match",
    matchId: null,
    isBot: true,
  };
}

function startBotMatch(socketId) {
  const c = conns.get(socketId);
  if (!c || c.status !== "queued") return;
  queue = queue.filter((id) => id !== socketId);
  clearBotTimer(c);
  createMatch(c, makeBotConn(c));
}

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
        settleWin(match, bot);
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
function genInviteCode() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from(
      { length: 6 },
      () => A[Math.floor(Math.random() * A.length)]
    ).join("");
  } while (invites.has(code));
  return code;
}

function removeInvitesBy(socketId) {
  for (const [code, rec] of invites)
    if (rec.hostSocketId === socketId) invites.delete(code);
  const c = conns.get(socketId);
  if (c && c.status === "inviting") c.status = "idle";
}

// Drop stale invites so a host who wandered off doesn't leave a dead link.
setInterval(() => {
  const cutoff = Date.now() - INVITE_TTL_MS;
  for (const [code, rec] of invites)
    if (rec.createdAt < cutoff) {
      invites.delete(code);
      const h = conns.get(rec.hostSocketId);
      if (h && h.status === "inviting") {
        h.status = "idle";
        h.socket.emit("inviteExpired");
      }
    }
}, 60_000).unref?.();

// ---------- Socket wiring ----------
io.on("connection", (socket) => {
  conns.set(socket.id, {
    socket,
    player: null,
    status: "idle",
    matchId: null,
  });

  // Account required: authenticate the socket with our session token
  // (obtained from POST /api/auth/google). No guest path.
  socket.on("auth", ({ token } = {}) => {
    const c = conns.get(socket.id);
    if (!c) return;
    const session = verifySession(token);
    const row = session?.sub ? getPlayer(session.sub) : null;
    if (!row) {
      socket.emit("authError", { message: "Please sign in again." });
      return;
    }
    c.player = row;
    socket.emit("authed", { player: publicPlayer(row) });
  });

  // Set a custom display name (persists to the account).
  socket.on("setNickname", ({ nickname } = {}) => {
    const c = conns.get(socket.id);
    if (!c?.player) {
      socket.emit("authError", { message: "Sign in first." });
      return;
    }
    const row = setNickname(c.player.id, nickname);
    if (!row) {
      socket.emit("nicknameError", {
        message: "Name must be 2–24 characters.",
      });
      return;
    }
    c.player = row;
    socket.emit("profileUpdated", { player: publicPlayer(row) });
  });

  socket.on("queue", () => {
    const c = conns.get(socket.id);
    if (!c?.player) {
      socket.emit("authError", { message: "Sign in to play." });
      return;
    }
    if (c.status === "inviting") removeInvitesBy(socket.id);
    if (c.status === "idle") enqueue(socket.id);
  });

  socket.on("cancelQueue", () => dequeue(socket.id));

  // ---- Private friend match via invite link (ranked) ----
  socket.on("createInvite", () => {
    const c = conns.get(socket.id);
    if (!c?.player) {
      socket.emit("authError", { message: "Sign in first." });
      return;
    }
    if (c.status === "queued") dequeue(socket.id);
    if (c.status !== "idle") {
      socket.emit("inviteError", { message: "Finish your current match first." });
      return;
    }
    removeInvitesBy(socket.id);
    const code = genInviteCode();
    invites.set(code, { hostSocketId: socket.id, createdAt: Date.now() });
    c.status = "inviting";
    socket.emit("inviteCreated", { code });
  });

  socket.on("cancelInvite", () => {
    removeInvitesBy(socket.id);
    socket.emit("inviteCancelled");
  });

  socket.on("joinInvite", ({ code } = {}) => {
    const c = conns.get(socket.id);
    if (!c?.player) {
      socket.emit("authError", { message: "Sign in to play." });
      return;
    }
    if (c.status === "queued") dequeue(socket.id);
    if (c.status === "inviting") removeInvitesBy(socket.id);
    if (c.status !== "idle") {
      socket.emit("inviteError", { message: "Finish your current match first." });
      return;
    }
    const rec = invites.get(String(code || "").toUpperCase());
    const host = rec && conns.get(rec.hostSocketId);
    if (!rec || !host || host.status !== "inviting") {
      socket.emit("inviteError", {
        message: "That invite link is invalid or expired.",
      });
      return;
    }
    if (host.socket.id === socket.id) {
      socket.emit("inviteError", { message: "You can't join your own invite." });
      return;
    }
    invites.delete(String(code).toUpperCase());
    removeInvitesBy(host.socket.id);
    createMatch(host, c);
  });

  socket.on("mediaDuration", ({ ms } = {}) => {
    const c = conns.get(socket.id);
    const m = c?.matchId && matches.get(c.matchId);
    if (m) onMediaDuration(m, socket.id, ms);
  });

  // The opening wouldn't play on this client → scrap the round, requeue both.
  socket.on("roundUnplayable", () => {
    const c = conns.get(socket.id);
    const m = c?.matchId && matches.get(c.matchId);
    if (m) abortUnplayable(m);
  });

  // A video link wouldn't play here — hand back the next version/encode of
  // the same OP. Alternates are fetched from AnimeThemes once per round
  // (lazily, only on a failure) and cached on the match. The client escalates
  // to roundUnplayable when we run out (url: null).
  socket.on("round:videoFailed", async ({ url } = {}) => {
    const c = conns.get(socket.id);
    const m = c?.matchId && matches.get(c.matchId);
    if (!m) return;
    if (!["preparing", "countdown", "playing"].includes(m.state)) return;
    const slug = m.opening?.anime?.slug;
    if (!slug) return socket.emit("round:altVideo", { url: null });
    if (!m.altLinksP)
      m.altLinksP = getThemeVideoLinks(slug, m.opening?.theme?.slug);
    let links = [];
    try {
      links = (await m.altLinksP) || [];
    } catch {
      links = [];
    }
    if (!matches.has(m.id)) return; // round/match ended while fetching
    const i = links.indexOf(url);
    const next = i >= 0 ? links[i + 1] : links.find((l) => l && l !== url);
    socket.emit("round:altVideo", { url: next || null });
  });

  socket.on("guess", ({ animeId, guessText } = {}) => {
    const c = conns.get(socket.id);
    const m = c?.matchId && matches.get(c.matchId);
    if (m) handleGuess(m, c, { animeId, guessText });
  });

  socket.on("rematchVote", ({ yes } = {}) => {
    const c = conns.get(socket.id);
    const m = c?.matchId && matches.get(c.matchId);
    if (m) onRematchVote(m, c, yes);
  });

  // ---- WebRTC signaling: relay verbatim to the other player in the match
  // (opt-in camera/mic). The server never inspects media, only forwards SDP
  // / ICE between exactly the two matched peers.
  const relayToOpponent = (event, payload) => {
    const c = conns.get(socket.id);
    const m = c?.matchId && matches.get(c.matchId);
    const other = m?.members.find((x) => x !== c);
    if (other) other.socket.emit(event, payload);
  };
  socket.on("rtc:signal", (payload) => relayToOpponent("rtc:signal", payload));
  socket.on("rtc:state", ({ cam, mic } = {}) =>
    relayToOpponent("rtc:peerState", { cam: !!cam, mic: !!mic })
  );

  // Voluntarily leave a match (e.g., user clicked "back to queue").
  socket.on("leaveMatch", () => {
    const c = conns.get(socket.id);
    const m = c?.matchId && matches.get(c.matchId);
    if (!m) return;
    if (m.state === "playing" || m.state === "countdown") {
      // Leaving mid-play forfeits the round — but, unlike a real disconnect,
      // the match stays alive so both can still rematch each other.
      voluntaryForfeit(m, c);
    } else {
      // Leaving from the result/vote screen: the leaver goes back to the
      // lobby; the other player stays parked on the result (their choice
      // when to re-queue).
      const other = m.members.find((x) => x !== c);
      clearTimers(m);
      matches.delete(m.id);
      c.socket.leave(m.id);
      c.matchId = null;
      c.status = "idle";
      c.socket.emit("match:over", { reason: "you_left" });
      parkAfterOpponentGone(m, "opponent_left", [other]);
    }
  });

  socket.on("disconnect", () => {
    const c = conns.get(socket.id);
    if (!c) return;
    dequeue(socket.id);
    removeInvitesBy(socket.id);
    const m = c.matchId && matches.get(c.matchId);
    if (m) handleDisconnectDuringMatch(m, c);
    conns.delete(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Anime Opening Elo (multiplayer) listening on port ${PORT}`);
  startIngester(); // trickle-fill the opening pool in the background
});
