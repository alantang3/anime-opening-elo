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

export const DEFAULT_ELO = 1200;
export const ELO_FLOOR = 100;

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

  CREATE INDEX IF NOT EXISTS idx_players_elo ON players(elo DESC);
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
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_players_google
     ON players(google_sub) WHERE google_sub IS NOT NULL`
);

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
           last_seen = @now
     WHERE id = @id
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
  touchGoogle: db.prepare(`
    UPDATE players
       SET nickname = @nickname, avatar = @avatar, last_seen = @now
     WHERE id = @id
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
};

// Look up (or create) the account for a verified Google profile, keyed by
// the stable Google `sub`. Refreshes display name + avatar each sign-in.
export function getOrCreateGooglePlayer({ sub, name, email, picture }) {
  const now = nowISO();
  const nickname = String(name || email || "Player").trim().slice(0, 24);
  const avatar = picture || null;
  const existing = stmt.getByGoogle.get(sub);
  if (existing) {
    stmt.touchGoogle.run({ id: existing.id, nickname, avatar, now });
    return { ...existing, nickname, avatar };
  }
  const id = crypto.randomUUID();
  stmt.insertGoogle.run({
    id, nickname, elo: DEFAULT_ELO, now,
    email: email || null, google_sub: sub, avatar,
  });
  return stmt.getByGoogle.get(sub);
}

export function getPlayer(id) {
  return stmt.getPlayer.get(id);
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

export default db;
