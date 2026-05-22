-- Initial Postgres schema for anime-opening-elo. Mirrors the SQLite schema
-- in db.js (the original better-sqlite3 store) so the import script can
-- copy rows 1:1. Run once against a fresh Supabase Pro database:
--
--   psql "$DATABASE_URL" -f server/migrations/001_init.sql
--
-- Idempotent: re-running is safe (all DDL uses IF NOT EXISTS).

-- ----- players -----
-- Account row, keyed on the same UUID format we issued under SQLite so
-- existing session JWTs (sub = player.id) keep working post-migration.
-- `peak_elo` is NULL on rows imported from very old SQLite versions; the
-- backfill UPDATE below copies elo into peak_elo where needed.
CREATE TABLE IF NOT EXISTS players (
  id               TEXT PRIMARY KEY,
  nickname         TEXT NOT NULL,
  elo              DOUBLE PRECISION NOT NULL DEFAULT 100,
  wins             INTEGER NOT NULL DEFAULT 0,
  losses           INTEGER NOT NULL DEFAULT 0,
  draws            INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  -- nullable: reserved for future password/email auth; only `google_sub`
  -- is actually used today.
  email            TEXT,
  password_hash    TEXT,
  auth_provider    TEXT,
  google_sub       TEXT,
  avatar           TEXT,
  avatar_is_custom INTEGER,
  peak_elo         DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_players_elo ON players(elo DESC);
-- Partial unique index: nullable Google sub for guests, but uniqueness
-- enforced for real Google accounts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_google
  ON players(google_sub)
  WHERE google_sub IS NOT NULL;

-- ----- mal_popularity -----
-- Cached MAL/AniList lookups keyed by MAL id. `titles` and
-- `anilist_titles` are JSON arrays serialized as TEXT (kept as TEXT so
-- the migration is a verbatim copy of the SQLite rows; can upgrade to
-- JSONB later if we want server-side filtering).
CREATE TABLE IF NOT EXISTS mal_popularity (
  mal_id         INTEGER PRIMARY KEY,
  members        INTEGER,
  score          DOUBLE PRECISION,
  title          TEXT,
  titles         TEXT,
  anilist_titles TEXT,
  fetched_at     TEXT NOT NULL
);

-- ----- match_history -----
-- Append-only ledger. id is BIGSERIAL so it monotonically increases
-- across all writers (we'll have multiple Node processes post-Tier-2).
-- The two compound indexes mirror Tier 1: each WHERE filter (winner_id
-- OR loser_id) hits its own index and Postgres bitmap-ORs the results.
CREATE TABLE IF NOT EXISTS match_history (
  id                BIGSERIAL PRIMARY KEY,
  played_at         TEXT NOT NULL,
  anime_name        TEXT,
  mal_id            INTEGER,
  outcome           TEXT NOT NULL,
  winner_id         TEXT,
  loser_id          TEXT,
  winner_name       TEXT,
  loser_name        TEXT,
  winner_elo_before DOUBLE PRECISION,
  winner_elo_after  DOUBLE PRECISION,
  loser_elo_before  DOUBLE PRECISION,
  loser_elo_after   DOUBLE PRECISION,
  duration_ms       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_history_winner
  ON match_history(winner_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_history_loser
  ON match_history(loser_id, id DESC);

-- ----- openings -----
-- The pre-built ready-to-serve opening pool. A round picks from here
-- with a single local query (no AnimeThemes call on the hot path); the
-- background ingester (pool.js) trickle-fills it.
CREATE TABLE IF NOT EXISTS openings (
  anime_id      INTEGER NOT NULL,
  theme_slug    TEXT NOT NULL,
  anime_slug    TEXT,
  anime_name    TEXT,
  year          INTEGER,
  song          TEXT,
  video_link    TEXT NOT NULL,
  audio_link    TEXT,
  mal_id        INTEGER,
  members       INTEGER,
  score         DOUBLE PRECISION,
  factor        DOUBLE PRECISION NOT NULL,
  franchise     TEXT,
  franchise_key TEXT,
  accepted      TEXT,
  dub_label     TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (anime_id, theme_slug)
);

CREATE INDEX IF NOT EXISTS idx_openings_members ON openings(members);
CREATE INDEX IF NOT EXISTS idx_openings_factor  ON openings(factor);

-- ----- backfills -----
-- Rows imported from old SQLite versions may have NULL peak_elo.
UPDATE players SET peak_elo = elo WHERE peak_elo IS NULL;
