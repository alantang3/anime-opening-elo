// SQLite persistence. Synchronous (better-sqlite3) — fine for a single
// Node process serving many concurrent socket players.
//
// Schema is deliberately account-ready: `players` keys on a guest UUID
// today, but carries nullable email/password_hash/auth_provider columns so
// real logins can be added later without a migration of the hot path.

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// On a host with a persistent disk, set DATA_DIR to the mounted volume path
// (see render.yaml) so the SQLite file survives redeploys. Defaults to a
// local ./data dir for development.
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DEFAULT_ELO = 100; // everyone starts at the floor
export const ELO_FLOOR = 100; // and can never drop below it

const db = new Database(path.join(DATA_DIR, "elo.db"));
db.pragma("journal_mode = WAL"); // better concurrent read/write behavior
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id            TEXT PRIMARY KEY,          -- guest UUID (or future account id)
    nickname      TEXT NOT NULL,
    elo           REAL NOT NULL DEFAULT ${DEFAULT_ELO},
    wins          INTEGER NOT NULL DEFAULT 0,
    losses        INTEGER NOT NULL DEFAULT 0,
    draws         INTEGER NOT NULL DEFAULT 0,  -- double-timeout = draw (both lose elo)
    created_at    TEXT NOT NULL,
    last_seen     TEXT NOT NULL,
    -- reserved for when guests become accounts; all nullable, unused for now
    email         TEXT,
    password_hash TEXT,
    auth_provider TEXT
  );

  CREATE TABLE IF NOT EXISTS mal_popularity (
    mal_id     INTEGER PRIMARY KEY,
    members    INTEGER,
    score      REAL,
    title      TEXT,
    titles     TEXT,                            -- JSON: all MAL title variants
    fetched_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS match_history (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    played_at         TEXT NOT NULL,
    anime_name        TEXT,
    mal_id            INTEGER,
    outcome           TEXT NOT NULL,          -- 'win' | 'timeout' | 'disconnect'
    winner_id         TEXT,                   -- null on timeout (no winner)
    loser_id          TEXT,
    winner_elo_before REAL,
    winner_elo_after  REAL,
    loser_elo_before  REAL,
    loser_elo_after   REAL,
    duration_ms       INTEGER
  );

  -- Pre-built, ready-to-serve openings. A round picks from here with a
  -- single local query (zero API calls); a background ingester fills it.
  CREATE TABLE IF NOT EXISTS openings (
    anime_id     INTEGER NOT NULL,
    theme_slug   TEXT NOT NULL,           -- OP1, OP1-EN, …
    anime_slug   TEXT,
    anime_name   TEXT,
    year         INTEGER,
    song         TEXT,
    video_link   TEXT NOT NULL,
    mal_id       INTEGER,
    members      INTEGER,                 -- MAL members (popularity gate)
    score        REAL,
    factor       REAL NOT NULL,           -- 0 popular … 1 obscure
    franchise    TEXT,
    franchise_key TEXT,
    accepted     TEXT,                    -- JSON array of accepted answers
    dub_label    TEXT,                    -- set when this is an English dub
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (anime_id, theme_slug)
  );

  CREATE INDEX IF NOT EXISTS idx_players_elo ON players(elo DESC);
  CREATE INDEX IF NOT EXISTS idx_openings_members ON openings(members);
  CREATE INDEX IF NOT EXISTS idx_openings_factor ON openings(factor);
`);

// Lightweight migrations for DBs created before a column existed.
// `CREATE TABLE IF NOT EXISTS` won't add columns to an existing table.
function ensureColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
ensureColumn("mal_popularity", "titles", "TEXT");
ensureColumn("players", "google_sub", "TEXT"); // Google account id (stable)
ensureColumn("players", "avatar", "TEXT");
ensureColumn("players", "avatar_is_custom", "INTEGER"); // user-uploaded pic
ensureColumn("players", "peak_elo", "REAL"); // highest Elo ever reached
db.exec(`UPDATE players SET peak_elo = elo WHERE peak_elo IS NULL`);
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_players_google
     ON players(google_sub) WHERE google_sub IS NOT NULL`
);

// One-time opt-in reset: set RESET_ELO=1 to wipe every existing account's
// rating/record back to the floor (then remove the env var). Useful after a
// tuning change so old accounts aren't stuck on ratings from the old system.
// peak_elo is reset too — otherwise it keeps the old high (it only ratchets
// up via MAX(...) on save) and the profile still shows the original peak.
if (process.env.RESET_ELO === "1") {
  const n = db
    .prepare(
      `UPDATE players
          SET elo = ${DEFAULT_ELO}, peak_elo = ${DEFAULT_ELO},
              wins = 0, losses = 0, draws = 0`
    )
    .run().changes;
  console.log(`RESET_ELO: reset ${n} player(s) to ${DEFAULT_ELO} Elo`);
}

const nowISO = () => new Date().toISOString();

const stmt = {
  getPlayer: db.prepare(`SELECT * FROM players WHERE id = ?`),
  insertPlayer: db.prepare(`
    INSERT INTO players (id, nickname, elo, created_at, last_seen)
    VALUES (@id, @nickname, @elo, @now, @now)
  `),
  touchPlayer: db.prepare(`
    UPDATE players SET nickname = @nickname, last_seen = @now WHERE id = @id
  `),
  setRecord: db.prepare(`
    UPDATE players
       SET elo = @elo, wins = @wins, losses = @losses, draws = @draws,
           peak_elo = MAX(COALESCE(peak_elo, elo), @elo),
           last_seen = @now
     WHERE id = @id
  `),
  setCustomAvatar: db.prepare(`
    UPDATE players SET avatar = @avatar, avatar_is_custom = 1 WHERE id = @id
  `),
  recentMatches: db.prepare(`
    SELECT h.played_at, h.anime_name, h.outcome, h.duration_ms,
           h.winner_id, h.loser_id,
           h.winner_elo_after, h.loser_elo_after,
           h.winner_elo_before, h.loser_elo_before,
           wp.nickname AS winner_name, lp.nickname AS loser_name
      FROM match_history h
      LEFT JOIN players wp ON wp.id = h.winner_id
      LEFT JOIN players lp ON lp.id = h.loser_id
     WHERE h.winner_id = @id OR h.loser_id = @id
     ORDER BY h.id DESC
     LIMIT @limit
  `),
  avgGuessMs: db.prepare(`
    SELECT AVG(duration_ms) AS avg
      FROM match_history
     WHERE winner_id = @id AND outcome = 'win' AND duration_ms > 0
  `),
  topPlayers: db.prepare(`
    SELECT id, nickname, elo, wins, losses, draws
      FROM players
     ORDER BY elo DESC
     LIMIT ?
  `),
  getPop: db.prepare(`SELECT * FROM mal_popularity WHERE mal_id = ?`),
  upsertPop: db.prepare(`
    INSERT INTO mal_popularity (mal_id, members, score, title, titles, fetched_at)
    VALUES (@mal_id, @members, @score, @title, @titles, @now)
    ON CONFLICT(mal_id) DO UPDATE SET
      members = @members, score = @score, title = @title,
      titles = @titles, fetched_at = @now
  `),
  getByGoogle: db.prepare(`SELECT * FROM players WHERE google_sub = ?`),
  insertGoogle: db.prepare(`
    INSERT INTO players
      (id, nickname, elo, created_at, last_seen,
       email, auth_provider, google_sub, avatar)
    VALUES
      (@id, @nickname, @elo, @now, @now,
       @email, 'google', @google_sub, @avatar)
  `),
  // Re-login refreshes avatar/email only — NEVER nickname, so a custom
  // username the player chose isn't overwritten by their Google name.
  touchGoogle: db.prepare(`
    UPDATE players
       SET avatar = CASE WHEN avatar_is_custom = 1 THEN avatar ELSE @avatar END,
           email = @email, last_seen = @now
     WHERE id = @id
  `),
  setNickname: db.prepare(`
    UPDATE players SET nickname = @nickname, last_seen = @now WHERE id = @id
  `),
  insertMatch: db.prepare(`
    INSERT INTO match_history
      (played_at, anime_name, mal_id, outcome, winner_id, loser_id,
       winner_elo_before, winner_elo_after, loser_elo_before, loser_elo_after,
       duration_ms)
    VALUES
      (@played_at, @anime_name, @mal_id, @outcome, @winner_id, @loser_id,
       @winner_elo_before, @winner_elo_after, @loser_elo_before,
       @loser_elo_after, @duration_ms)
  `),
  upsertOpening: db.prepare(`
    INSERT INTO openings
      (anime_id, theme_slug, anime_slug, anime_name, year, song, video_link,
       mal_id, members, score, factor, franchise, franchise_key, accepted,
       dub_label, updated_at)
    VALUES
      (@anime_id, @theme_slug, @anime_slug, @anime_name, @year, @song,
       @video_link, @mal_id, @members, @score, @factor, @franchise,
       @franchise_key, @accepted, @dub_label, @now)
    ON CONFLICT(anime_id, theme_slug) DO UPDATE SET
      video_link=@video_link, mal_id=@mal_id, members=@members,
      score=@score, factor=@factor, franchise=@franchise,
      franchise_key=@franchise_key, accepted=@accepted,
      dub_label=@dub_label, anime_name=@anime_name, song=@song,
      year=@year, updated_at=@now
  `),
  countOpenings: db.prepare(`SELECT COUNT(*) AS n FROM openings`),
  // Closest to the difficulty target among shows that clear the members
  // floor; LIMIT gives a small band we then randomise over for variety.
  bandByFloor: db.prepare(`
    SELECT * FROM openings
     WHERE members >= @minMembers
     ORDER BY ABS(factor - @target) ASC
     LIMIT @limit
  `),
  // Fallback when nothing clears the floor: the most popular we have.
  mostPopular: db.prepare(`
    SELECT * FROM openings ORDER BY members DESC LIMIT @limit
  `),
};

// Look up (or create) the account for a verified Google profile, keyed by
// the stable Google `sub`. Refreshes display name + avatar each sign-in.
export function getOrCreateGooglePlayer({ sub, name, email, picture }) {
  const now = nowISO();
  const nickname = String(name || email || "Player").trim().slice(0, 24);
  const avatar = picture || null;
  const existing = stmt.getByGoogle.get(sub);
  if (existing) {
    stmt.touchGoogle.run({ id: existing.id, avatar, email: email || null, now });
    return stmt.getByGoogle.get(sub); // re-read: keeps custom avatar/nickname
  }
  const id = crypto.randomUUID();
  stmt.insertGoogle.run({
    id, nickname, elo: DEFAULT_ELO, now,
    email: email || null, google_sub: sub, avatar,
  });
  return stmt.getByGoogle.get(sub);
}

// Set a player's chosen display name. Returns the updated row (or null).
export function setNickname(id, nickname) {
  const clean = String(nickname || "").replace(/\s+/g, " ").trim().slice(0, 24);
  if (clean.length < 2) return null;
  stmt.setNickname.run({ id, nickname: clean, now: nowISO() });
  return stmt.getPlayer.get(id);
}

export function getPlayer(id) {
  return stmt.getPlayer.get(id);
}

export function setCustomAvatar(id, avatarPath) {
  stmt.setCustomAvatar.run({ id, avatar: avatarPath });
  return stmt.getPlayer.get(id);
}

// Aggregate stats + recent matches for one player, from the player's own
// perspective (win/loss, Elo delta, opponent).
export function getPlayerStats(id, limit = 12) {
  const p = stmt.getPlayer.get(id);
  if (!p) return null;
  const games = p.wins + p.losses + p.draws;
  const avgRow = stmt.avgGuessMs.get({ id });
  const recent = stmt.recentMatches.all({ id, limit }).map((m) => {
    const won = m.winner_id === id;
    const isTimeout = m.outcome === "timeout";
    const before = won ? m.winner_elo_before : m.loser_elo_before;
    const after = won ? m.winner_elo_after : m.loser_elo_after;
    const oppName = won ? m.loser_name : m.winner_name;
    return {
      at: m.played_at,
      anime: m.anime_name,
      outcome: m.outcome,
      youWon: isTimeout ? false : won,
      opponent: oppName || "Bot",
      eloAfter: after != null ? Math.round(after) : null,
      delta:
        before != null && after != null
          ? Math.round((after - before) * 10) / 10
          : null,
      durationMs: m.duration_ms,
    };
  });
  return {
    elo: Math.round(p.elo),
    peakElo: Math.round(p.peak_elo ?? p.elo),
    wins: p.wins,
    losses: p.losses,
    draws: p.draws,
    games,
    winrate: games ? Math.round((p.wins / games) * 100) : 0,
    avgGuessMs: avgRow?.avg ? Math.round(avgRow.avg) : null,
    recent,
  };
}

// Apply one finished round atomically: both players' new elo + W/L/D and a
// history row. `outcome` is 'win'/'disconnect' (winner+loser) or 'timeout'
// (no winner — both took `loser`-style losses, recorded as a draw each).
export const applyMatchResult = db.transaction((r) => {
  const now = nowISO();

  if (r.outcome === "timeout") {
    for (const p of [r.a, r.b]) {
      stmt.setRecord.run({
        id: p.id, elo: p.eloAfter,
        wins: p.wins, losses: p.losses, draws: p.draws + 1, now,
      });
    }
    stmt.insertMatch.run({
      played_at: now, anime_name: r.animeName, mal_id: r.malId,
      outcome: "timeout", winner_id: null, loser_id: null,
      winner_elo_before: null, winner_elo_after: null,
      loser_elo_before: null, loser_elo_after: null,
      duration_ms: r.durationMs,
    });
    return;
  }

  stmt.setRecord.run({
    id: r.winner.id, elo: r.winner.eloAfter,
    wins: r.winner.wins + 1, losses: r.winner.losses,
    draws: r.winner.draws, now,
  });
  stmt.setRecord.run({
    id: r.loser.id, elo: r.loser.eloAfter,
    wins: r.loser.wins, losses: r.loser.losses + 1,
    draws: r.loser.draws, now,
  });
  stmt.insertMatch.run({
    played_at: now, anime_name: r.animeName, mal_id: r.malId,
    outcome: r.outcome, winner_id: r.winner.id, loser_id: r.loser.id,
    winner_elo_before: r.winner.eloBefore, winner_elo_after: r.winner.eloAfter,
    loser_elo_before: r.loser.eloBefore, loser_elo_after: r.loser.eloAfter,
    duration_ms: r.durationMs,
  });
});

export function leaderboard(limit = 20) {
  return stmt.topPlayers.all(limit).map((p) => ({
    ...p,
    elo: Math.round(p.elo),
  }));
}

export function getCachedPopularity(malId) {
  return stmt.getPop.get(malId) || null;
}

export function cachePopularity({ malId, members, score, title, titles }) {
  stmt.upsertPop.run({
    mal_id: malId,
    members: members ?? null,
    score: score ?? null,
    title: title ?? null,
    titles: titles && titles.length ? JSON.stringify(titles) : null,
    now: nowISO(),
  });
}

// ---------- Opening pool ----------
export function upsertOpening(row) {
  stmt.upsertOpening.run({
    anime_id: row.animeId,
    theme_slug: row.themeSlug,
    anime_slug: row.animeSlug ?? null,
    anime_name: row.animeName ?? null,
    year: row.year ?? null,
    song: row.song ?? null,
    video_link: row.videoLink,
    mal_id: row.malId ?? null,
    members: Number.isFinite(row.members) ? row.members : null,
    score: row.score ?? null,
    factor: row.factor,
    franchise: row.franchise ?? null,
    franchise_key: row.franchiseKey ?? null,
    accepted: row.accepted ? JSON.stringify(row.accepted) : null,
    dub_label: row.dubLabel ?? null,
    now: nowISO(),
  });
}

export function poolSize() {
  return stmt.countOpenings.get().n;
}

// Pick a ready-to-serve opening for the given difficulty. Prefers shows above
// the members floor closest to `target`, randomised over a small band for
// variety; relaxes to the most popular pooled show if none clear the floor.
export function pickPooledOpening({ minMembers, target, band = 25 }) {
  let rows = stmt.bandByFloor.all({ minMembers, target, limit: band });
  if (!rows.length) rows = stmt.mostPopular.all({ limit: band });
  if (!rows.length) return null;
  const r = rows[Math.floor(Math.random() * rows.length)];
  return {
    animeId: r.anime_id,
    animeName: r.anime_name,
    animeSlug: r.anime_slug,
    themeSlug: r.theme_slug,
    year: r.year,
    song: r.song,
    videoLink: r.video_link,
    malId: r.mal_id,
    members: r.members,
    score: r.score,
    factor: r.factor,
    franchise: r.franchise,
    franchiseKey: r.franchise_key,
    accepted: r.accepted ? JSON.parse(r.accepted) : [],
    dubLabel: r.dub_label,
  };
}

export default db;
