// Postgres persistence (was SQLite/better-sqlite3 in earlier versions).
// Driven by DATABASE_URL — Supabase, Render PG, local Docker, all
// accept the same connection-string format.
//
// All exports are ASYNC because pg is wire-protocol — there's no
// synchronous client. Callers must `await`. The Tier 2 migration touched
// every callsite to add awaits; see the commit that introduced this file.
//
// Schema lives in server/migrations/001_init.sql. Run it ONCE against a
// fresh database before booting:
//   psql "$DATABASE_URL" -f server/migrations/001_init.sql
// (or paste into Supabase SQL editor). Existing SQLite data can be
// pushed up via server/scripts/import-from-sqlite.js.

import pg from "pg";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR still exists — auth.js writes the session secret here, and the
// avatar directory still lives on disk until Phase 2 (object storage).
// On Render, DATA_DIR is the mounted persistent volume; locally it's
// ./data alongside this file.
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DEFAULT_ELO = 100; // everyone starts at the floor
export const ELO_FLOOR = 100; // and can never drop below it

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Provision a Postgres database (Supabase Pro " +
    "in production) and put the connection string in DATABASE_URL. Then " +
    "run: psql \"$DATABASE_URL\" -f server/migrations/001_init.sql"
  );
}

// Pool sized conservatively — Supabase Pro caps at ~60 direct connections.
// With multi-process (Path B Phase 5) each process owns its own pool, so
// max=10 leaves headroom for ~6 processes. If you hit "too many clients",
// either lower this, use the Supabase pooler URL (port 6543), or upgrade.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 10,
  // Supabase requires TLS but uses a self-signed cert in some configs;
  // rejectUnauthorized=false matches the standard Supabase recipe.
  ssl:
    process.env.PG_SSL === "off"
      ? false
      : { rejectUnauthorized: false },
});

// Surface pool errors instead of letting them crash silently — a stale
// connection in the pool would otherwise emit an uncaught error.
pool.on("error", (err) => {
  console.error("pg pool error:", err.message);
});

const nowISO = () => new Date().toISOString();

// Thin wrapper: pg returns { rows }. Most call sites just want rows[0]
// or rows. These two helpers cut boilerplate without hiding the driver.
const q = (text, params) => pool.query(text, params);
const qOne = async (text, params) => (await q(text, params)).rows[0] || null;

// One-shot env flags — same as the SQLite version. RESET_ELO and
// RESET_POOL are bootstrap conveniences for after tuning changes;
// remove the env var after a single boot.
if (process.env.RESET_ELO === "1") {
  const r = await q(
    `UPDATE players SET elo = $1, peak_elo = $1, wins = 0, losses = 0, draws = 0`,
    [DEFAULT_ELO]
  );
  console.log(`RESET_ELO: reset ${r.rowCount} player(s) to ${DEFAULT_ELO} Elo`);
}
if (process.env.RESET_POOL === "1") {
  const r = await q(`DELETE FROM openings`);
  console.log(`RESET_POOL: cleared ${r.rowCount} pooled opening(s)`);
}

// ---------- Player CRUD ----------

export async function getPlayer(id) {
  return qOne(`SELECT * FROM players WHERE id = $1`, [id]);
}

export async function getOrCreateGooglePlayer({ sub, name, email, picture }) {
  const now = nowISO();
  const nickname = String(name || email || "Player").trim().slice(0, 24);
  const avatar = picture || null;
  const existing = await qOne(
    `SELECT * FROM players WHERE google_sub = $1`,
    [sub]
  );
  if (existing) {
    // Re-login refreshes avatar/email only — NEVER nickname. A custom
    // username chosen by the player isn't overwritten by their Google name.
    await q(
      `UPDATE players
          SET avatar = CASE WHEN avatar_is_custom = 1 THEN avatar ELSE $1 END,
              email = $2, last_seen = $3
        WHERE id = $4`,
      [avatar, email || null, now, existing.id]
    );
    return qOne(`SELECT * FROM players WHERE google_sub = $1`, [sub]);
  }
  const id = crypto.randomUUID();
  await q(
    `INSERT INTO players
       (id, nickname, elo, created_at, last_seen, email, auth_provider, google_sub, avatar)
     VALUES ($1, $2, $3, $4, $4, $5, 'google', $6, $7)`,
    [id, nickname, DEFAULT_ELO, now, email || null, sub, avatar]
  );
  return qOne(`SELECT * FROM players WHERE google_sub = $1`, [sub]);
}

export async function createGuestPlayer({ nickname, avatar }) {
  const clean =
    String(nickname || "").replace(/\s+/g, " ").trim().slice(0, 24) || "Guest";
  const id = crypto.randomUUID();
  const now = nowISO();
  await q(
    `INSERT INTO players
       (id, nickname, elo, created_at, last_seen, auth_provider, avatar)
     VALUES ($1, $2, $3, $4, $4, 'guest', $5)`,
    [id, clean, DEFAULT_ELO, now, avatar || null]
  );
  return getPlayer(id);
}

export async function setNickname(id, nickname) {
  const clean = String(nickname || "").replace(/\s+/g, " ").trim().slice(0, 24);
  if (clean.length < 2) return null;
  await q(
    `UPDATE players SET nickname = $1, last_seen = $2 WHERE id = $3`,
    [clean, nowISO(), id]
  );
  return getPlayer(id);
}

export async function setCustomAvatar(id, avatarPath) {
  await q(
    `UPDATE players SET avatar = $1, avatar_is_custom = 1 WHERE id = $2`,
    [avatarPath, id]
  );
  return getPlayer(id);
}

// ---------- Stats / leaderboard ----------

export async function leaderboard(limit = 20) {
  const r = await q(
    `SELECT id, nickname, elo, wins, losses, draws, avatar
       FROM players
      ORDER BY elo DESC
      LIMIT $1`,
    [limit]
  );
  return r.rows.map((p) => ({ ...p, elo: Math.round(p.elo) }));
}

export async function getPlayerStats(id, limit = 12) {
  const p = await getPlayer(id);
  if (!p) return null;
  const games = p.wins + p.losses + p.draws;
  const avgRow = await qOne(
    `SELECT AVG(duration_ms) AS avg
       FROM match_history
      WHERE winner_id = $1 AND outcome = 'win' AND duration_ms > 0`,
    [id]
  );
  // recentMatches: filtered by (winner_id = $1 OR loser_id = $1). The
  // (winner_id, id DESC) and (loser_id, id DESC) indexes let Postgres
  // BitmapOr the two index scans instead of full-scanning the table.
  const r = await q(
    `SELECT h.played_at, h.anime_name, h.outcome, h.duration_ms,
            h.winner_id, h.loser_id,
            h.winner_elo_after, h.loser_elo_after,
            h.winner_elo_before, h.loser_elo_before,
            COALESCE(h.winner_name, wp.nickname) AS winner_name,
            COALESCE(h.loser_name,  lp.nickname) AS loser_name
       FROM match_history h
       LEFT JOIN players wp ON wp.id = h.winner_id
       LEFT JOIN players lp ON lp.id = h.loser_id
      WHERE h.winner_id = $1 OR h.loser_id = $1
      ORDER BY h.id DESC
      LIMIT $2`,
    [id, limit]
  );
  const recent = r.rows.map((m) => {
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
      // Old SQLite rows pre-snapshot-columns may have NULL opponent
      // names. Fall back to a neutral placeholder (NOT "Bot" — that
      // would give the game away on a bot-played row).
      opponent: oppName || "Unknown",
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
    avgGuessMs: avgRow?.avg ? Math.round(Number(avgRow.avg)) : null,
    recent,
  };
}

// ---------- Match result (transactional) ----------
// Two UPDATEs to players + one INSERT into match_history, wrapped in a
// transaction so a crash mid-write can't leave the players table updated
// without a corresponding history row (or vice versa).
export async function applyMatchResult(r) {
  const client = await pool.connect();
  const now = nowISO();
  try {
    await client.query("BEGIN");

    if (r.outcome === "timeout") {
      for (const p of [r.a, r.b]) {
        await client.query(
          `UPDATE players
              SET elo = $1, wins = $2, losses = $3, draws = $4,
                  peak_elo = GREATEST(COALESCE(peak_elo, elo), $1),
                  last_seen = $5
            WHERE id = $6`,
          [p.eloAfter, p.wins, p.losses, p.draws + 1, now, p.id]
        );
      }
      // Both participants are stored in winner_id/loser_id (arbitrary
      // which side); the recent-matches query filters by
      // winner_id|loser_id so it picks the draw up in both histories.
      // outcome === "timeout" tells the client to render it as DRAW
      // regardless of which side ended up in the "winner" column.
      await client.query(
        `INSERT INTO match_history
           (played_at, anime_name, mal_id, outcome,
            winner_id, loser_id, winner_name, loser_name,
            winner_elo_before, winner_elo_after,
            loser_elo_before, loser_elo_after, duration_ms)
         VALUES ($1, $2, $3, 'timeout',
                 $4, $5, $6, $7,
                 $8, $9, $10, $11, $12)`,
        [
          now, r.animeName, r.malId,
          r.a.id, r.b.id, r.a.nickname || null, r.b.nickname || null,
          r.a.eloBefore ?? null, r.a.eloAfter,
          r.b.eloBefore ?? null, r.b.eloAfter,
          r.durationMs,
        ]
      );
      await client.query("COMMIT");
      return;
    }

    // A voluntary forfeit is a "no contest" for the non-forfeit side:
    // their Elo and W/L are unchanged (no wins-counter farm) while the
    // forfeiter takes a real loss. resolveWin already zeroed winnerGain
    // so eloAfter equals eloBefore here, but we still skip the UPDATE
    // entirely so the wins counter doesn't tick up.
    const isForfeit = r.outcome === "forfeit";
    if (!isForfeit) {
      await client.query(
        `UPDATE players
            SET elo = $1, wins = $2, losses = $3, draws = $4,
                peak_elo = GREATEST(COALESCE(peak_elo, elo), $1),
                last_seen = $5
          WHERE id = $6`,
        [r.winner.eloAfter, r.winner.wins + 1, r.winner.losses,
         r.winner.draws, now, r.winner.id]
      );
    }
    await client.query(
      `UPDATE players
          SET elo = $1, wins = $2, losses = $3, draws = $4,
              peak_elo = GREATEST(COALESCE(peak_elo, elo), $1),
              last_seen = $5
        WHERE id = $6`,
      [r.loser.eloAfter, r.loser.wins, r.loser.losses + 1,
       r.loser.draws, now, r.loser.id]
    );
    await client.query(
      `INSERT INTO match_history
         (played_at, anime_name, mal_id, outcome,
          winner_id, loser_id, winner_name, loser_name,
          winner_elo_before, winner_elo_after,
          loser_elo_before, loser_elo_after, duration_ms)
       VALUES ($1, $2, $3, $4,
               $5, $6, $7, $8,
               $9, $10, $11, $12, $13)`,
      [
        now, r.animeName, r.malId, r.outcome,
        r.winner.id, r.loser.id,
        r.winner.nickname || null, r.loser.nickname || null,
        r.winner.eloBefore, r.winner.eloAfter,
        r.loser.eloBefore, r.loser.eloAfter,
        r.durationMs,
      ]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------- Popularity cache ----------

export async function getCachedPopularity(malId) {
  return qOne(`SELECT * FROM mal_popularity WHERE mal_id = $1`, [malId]);
}

export async function cachePopularity({ malId, members, score, title, titles }) {
  await q(
    `INSERT INTO mal_popularity (mal_id, members, score, title, titles, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (mal_id) DO UPDATE SET
       members = EXCLUDED.members,
       score = EXCLUDED.score,
       title = EXCLUDED.title,
       titles = EXCLUDED.titles,
       fetched_at = EXCLUDED.fetched_at`,
    [
      malId,
      members ?? null,
      score ?? null,
      title ?? null,
      titles && titles.length ? JSON.stringify(titles) : null,
      nowISO(),
    ]
  );
}

// AniList titles cache lives in the SAME mal_popularity row but is
// updated independently so a fresh AniList fetch doesn't reset the Jikan
// fetched_at (and vice versa). The empty-row case (AniList arriving
// before any Jikan fetch for this id) creates a placeholder row with
// only anilist_titles + sentinel fetched_at; a later Jikan call
// upserts the rest.
export async function getCachedAnilistTitles(malId) {
  const row = await qOne(
    `SELECT anilist_titles FROM mal_popularity WHERE mal_id = $1`,
    [malId]
  );
  if (!row || row.anilist_titles == null) return null;
  try {
    const a = JSON.parse(row.anilist_titles);
    return Array.isArray(a) ? a : [];
  } catch {
    return null;
  }
}

export async function cacheAnilistTitles(malId, titles) {
  await q(
    `INSERT INTO mal_popularity (mal_id, anilist_titles, fetched_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (mal_id) DO UPDATE SET
       anilist_titles = EXCLUDED.anilist_titles`,
    [malId, JSON.stringify(titles || []), nowISO()]
  );
}

// Count of cached popularity rows. Used by the ingester (pool.js) to
// smart-start its Jikan-page cursor on boot — without this, a redeploy
// resets popPage to 1 and the ingester wastes ~75 min (in warm mode)
// re-walking the same already-cached pages before adding a new row.
export async function cachedPopularityCount() {
  const r = await qOne(`SELECT COUNT(*)::int AS n FROM mal_popularity`);
  return r?.n ?? 0;
}

// ---------- Opening pool ----------

export async function upsertOpening(row) {
  await q(
    `INSERT INTO openings
       (anime_id, theme_slug, anime_slug, anime_name, year, song, video_link,
        audio_link, mal_id, members, score, factor, franchise, franchise_key,
        accepted, dub_label, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (anime_id, theme_slug) DO UPDATE SET
       video_link    = EXCLUDED.video_link,
       audio_link    = EXCLUDED.audio_link,
       mal_id        = EXCLUDED.mal_id,
       members       = EXCLUDED.members,
       score         = EXCLUDED.score,
       factor        = EXCLUDED.factor,
       franchise     = EXCLUDED.franchise,
       franchise_key = EXCLUDED.franchise_key,
       accepted      = EXCLUDED.accepted,
       dub_label     = EXCLUDED.dub_label,
       anime_name    = EXCLUDED.anime_name,
       song          = EXCLUDED.song,
       year          = EXCLUDED.year,
       updated_at    = EXCLUDED.updated_at`,
    [
      row.animeId,
      row.themeSlug,
      row.animeSlug ?? null,
      row.animeName ?? null,
      row.year ?? null,
      row.song ?? null,
      row.videoLink,
      row.audioLink ?? null,
      row.malId ?? null,
      Number.isFinite(row.members) ? row.members : null,
      row.score ?? null,
      row.factor,
      row.franchise ?? null,
      row.franchiseKey ?? null,
      row.accepted ? JSON.stringify(row.accepted) : null,
      row.dubLabel ?? null,
      nowISO(),
    ]
  );
}

export async function poolSize() {
  const r = await qOne(`SELECT COUNT(*)::int AS n FROM openings`);
  return r?.n ?? 0;
}

// Pick a ready-to-serve opening for the given difficulty.
// 1) From a band of distinct anime nearest the difficulty target that
//    clear the members floor, pick one anime uniformly.
// 2) Of that anime's pooled OPs (still respecting the floor), pick one
//    at random.
// Relaxes to "the most popular shows we have" if NO show clears the
// floor — better to serve something popular than nothing.
export async function pickPooledOpening({ minMembers, target, band = 25 }) {
  let { rows: animeRows } = await q(
    `SELECT anime_id, MIN(factor) AS factor
       FROM openings
      WHERE members >= $1
      GROUP BY anime_id
      ORDER BY ABS(MIN(factor) - $2) ASC
      LIMIT $3`,
    [minMembers, target, band]
  );
  let floorForPick = minMembers;
  if (!animeRows.length) {
    const r2 = await q(
      `SELECT anime_id
         FROM openings
        GROUP BY anime_id
        ORDER BY MAX(members) DESC NULLS LAST
        LIMIT $1`,
      [band]
    );
    animeRows = r2.rows;
    floorForPick = 0; // fallback: ignore the floor entirely
  }
  if (!animeRows.length) return null;
  const a = animeRows[Math.floor(Math.random() * animeRows.length)];
  const r = await qOne(
    `SELECT * FROM openings
      WHERE anime_id = $1 AND members >= $2
      ORDER BY RANDOM() LIMIT 1`,
    [a.anime_id, floorForPick]
  );
  if (!r) return null;
  return {
    animeId: r.anime_id,
    animeName: r.anime_name,
    animeSlug: r.anime_slug,
    themeSlug: r.theme_slug,
    year: r.year,
    song: r.song,
    videoLink: r.video_link,
    audioLink: r.audio_link,
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

// Rescue pool rows whose `members` froze NULL (MAL was down the first
// time that show was drawn) by copying the now-known count from the
// popularity cache and recomputing `factor`. `membersToFactor` is passed
// in to avoid an import cycle (popularity.js already imports this
// module). Returns the number of rows fixed.
export async function backfillOpeningsFromCache(membersToFactor) {
  const r = await q(
    `SELECT o.anime_id, o.theme_slug, p.members, p.score
       FROM openings o
       JOIN mal_popularity p ON p.mal_id = o.mal_id
      WHERE o.members IS NULL AND p.members IS NOT NULL`
  );
  if (!r.rows.length) return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of r.rows) {
      await client.query(
        `UPDATE openings
            SET members = $1, score = $2, factor = $3
          WHERE anime_id = $4 AND theme_slug = $5`,
        [
          row.members,
          row.score,
          membersToFactor(row.members),
          row.anime_id,
          row.theme_slug,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return r.rows.length;
}
