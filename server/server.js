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
import { Server } from "socket.io";

import {
  getOrCreatePlayer,
  getPlayer,
  applyMatchResult,
  leaderboard,
} from "./db.js";
import { searchAnime } from "./animethemes.js";
import { pickOpeningForElo } from "./selectOpening.js";
import { resolveWin, resolveTimeout } from "./elo.js";

// ---------- Tunables ----------
const PORT = process.env.PORT || 5174;
const COUNTDOWN_MS = 3000; // 3-2-1 before audio, masks network jitter
const DURATION_MIN_MS = 10_000;
const DURATION_MAX_MS = 120_000; // OPs are ~90s; hard cap against a lying client
const DURATION_FALLBACK_MS = 90_000; // used if neither client reports in time
const DURATION_REPORT_WAIT_MS = 8_000;
const REMATCH_TIMEOUT_MS = 25_000;

// ---------- HTTP ----------
const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/search", async (req, res) => {
  try {
    res.json({ results: await searchAnime(String(req.query.q || "")) });
  } catch (err) {
    console.error("search:", err.message);
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get("/api/leaderboard", (_req, res) => {
  res.json({ players: leaderboard(20) });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

// ---------- Connection + match state ----------
// socket.id -> { socket, guestId, player, status: 'idle'|'queued'|'match', matchId }
const conns = new Map();
// FIFO matchmaking queue of socket ids.
let queue = [];
// matchId -> Match
const matches = new Map();

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
  return { nickname: s.nickname, elo: s.elo, wins: s.wins, losses: s.losses };
}

// ---------- Matchmaking ----------
function enqueue(socketId) {
  const c = conns.get(socketId);
  if (!c || c.status !== "idle") return;
  if (!queue.includes(socketId)) queue.push(socketId);
  c.status = "queued";
  c.socket.emit("queued");
  tryMatch();
}

function dequeue(socketId) {
  queue = queue.filter((id) => id !== socketId);
  const c = conns.get(socketId);
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
    members: [a, b], // connection contexts
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
    c.status = "match";
    c.matchId = id;
    c.socket.join(id);
  }
  const [pa, pb] = match.members;
  pa.socket.emit("matchFound", {
    you: publicPlayer(pa.player),
    opponent: publicPlayer(pb.player),
  });
  pb.socket.emit("matchFound", {
    you: publicPlayer(pb.player),
    opponent: publicPlayer(pa.player),
  });

  startRound(match);
}

async function startRound(match) {
  match.state = "preparing";
  match.round += 1;
  match.opening = null;
  match.correctAnimeId = null;
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
  // Once both clients have reported, start without waiting out the timer.
  if (match.reported.size >= match.members.length) {
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
  }, COUNTDOWN_MS);
}

function handleGuess(match, conn, animeId) {
  if (!match || match.state !== "playing") return;
  const correct = Number(animeId) === match.correctAnimeId;

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

  emitRoundEnd(match, {
    outcome: match.disconnectForfeit ? "disconnect" : "win",
    [winnerConn.socket.id]: {
      youWon: true,
      eloBefore: Math.round(w.eloRaw),
      eloAfter: Math.round(r.winnerAfter),
      delta: r.winnerDelta,
    },
    [loserConn.socket.id]: {
      youWon: false,
      eloBefore: Math.round(l.eloRaw),
      eloAfter: Math.round(r.loserAfter),
      delta: r.loserDelta,
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

  emitRoundEnd(match, {
    outcome: "timeout",
    [ca.socket.id]: {
      youWon: false,
      eloBefore: Math.round(a.eloRaw),
      eloAfter: Math.round(r.aAfter),
      delta: r.aDelta,
    },
    [cb.socket.id]: {
      youWon: false,
      eloBefore: Math.round(b.eloRaw),
      eloAfter: Math.round(r.bAfter),
      delta: r.bDelta,
    },
  });
  beginRematch(match);
}

function emitRoundEnd(match, perSocket) {
  const answer = {
    id: match.correctAnimeId,
    name: match.opening.anime.name,
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
  match.timers.rematch = setTimeout(() => {
    // Treat no-decision as "no".
    dissolveMatch(match, { requeue: true, reason: "rematch_timeout" });
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
    dissolveMatch(match, { requeue: true, reason: "declined" });
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
    c.socket.leave(match.id);
    c.matchId = null;
    c.status = "idle";
    if (c.socket.id === leaverId) continue;
    c.socket.emit("match:over", { reason: reason || "ended" });
    if (requeue) enqueue(c.socket.id);
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
    settleWin(match, other);
    // After the forfeit result, the survivor goes back to the queue.
    other.socket.emit("opponent:left", { forfeited: true });
    finalizeAfterForfeit(match, other);
    return;
  }

  // Disconnect while preparing / showing result / voting: no Elo change.
  clearTimers(match);
  matches.delete(match.id);
  other.socket.leave(match.id);
  other.matchId = null;
  other.status = "idle";
  other.socket.emit("opponent:left", { forfeited: false });
  enqueue(other.socket.id);
}

function finalizeAfterForfeit(match, survivor) {
  // settleWin set state=result and started a rematch; tear that down since
  // the opponent is gone, and requeue the survivor.
  clearTimers(match);
  matches.delete(match.id);
  survivor.socket.leave(match.id);
  survivor.matchId = null;
  survivor.status = "idle";
  enqueue(survivor.socket.id);
}

// ---------- Socket wiring ----------
io.on("connection", (socket) => {
  conns.set(socket.id, {
    socket,
    guestId: null,
    player: null,
    status: "idle",
    matchId: null,
  });

  socket.on("join", ({ nickname, guestId } = {}) => {
    const c = conns.get(socket.id);
    if (!c) return;
    const name = String(nickname || "").trim().slice(0, 24) || "Anon";
    const id = guestId && String(guestId).length <= 64
      ? String(guestId)
      : crypto.randomUUID();
    c.guestId = id;
    c.player = getOrCreatePlayer(id, name);
    socket.emit("joined", {
      guestId: id,
      player: publicPlayer(c.player),
    });
  });

  socket.on("queue", () => {
    const c = conns.get(socket.id);
    if (!c?.player) {
      socket.emit("errorMsg", { message: "Pick a nickname first." });
      return;
    }
    if (c.status === "idle") enqueue(socket.id);
  });

  socket.on("cancelQueue", () => dequeue(socket.id));

  socket.on("mediaDuration", ({ ms } = {}) => {
    const c = conns.get(socket.id);
    const m = c?.matchId && matches.get(c.matchId);
    if (m) onMediaDuration(m, socket.id, ms);
  });

  socket.on("guess", ({ animeId } = {}) => {
    const c = conns.get(socket.id);
    const m = c?.matchId && matches.get(c.matchId);
    if (m) handleGuess(m, c, animeId);
  });

  socket.on("rematchVote", ({ yes } = {}) => {
    const c = conns.get(socket.id);
    const m = c?.matchId && matches.get(c.matchId);
    if (m) onRematchVote(m, c, yes);
  });

  // Voluntarily leave a match (e.g., user clicked "back to queue").
  socket.on("leaveMatch", () => {
    const c = conns.get(socket.id);
    const m = c?.matchId && matches.get(c.matchId);
    if (!m) return;
    if (m.state === "playing" || m.state === "countdown") {
      // Leaving mid-play forfeits, same as a disconnect.
      handleDisconnectDuringMatch(m, c);
    } else {
      dissolveMatch(m, { requeue: true, reason: "left" }, socket.id);
      c.socket.emit("match:over", { reason: "you_left" });
    }
  });

  socket.on("disconnect", () => {
    const c = conns.get(socket.id);
    if (!c) return;
    dequeue(socket.id);
    const m = c.matchId && matches.get(c.matchId);
    if (m) handleDisconnectDuringMatch(m, c);
    conns.delete(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(
    `Anime Opening Elo (multiplayer) listening on http://localhost:${PORT}`
  );
});
