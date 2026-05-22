// One-time migration: import every row from the legacy SQLite file into
// the newly-provisioned Postgres database. Idempotent (ON CONFLICT DO
// NOTHING on stable keys), so rerunning is safe — useful if you do a
// dry-run against staging first, then point at production.
//
// Usage (from repo root or server/):
//
//   DATABASE_URL='postgres://...' SQLITE_PATH=./server/data/elo.db \
//     node server/scripts/import-from-sqlite.js
//
// Notes:
//   - SQLITE_PATH defaults to DATA_DIR/elo.db (same default as the old
//     better-sqlite3 path), so on Render with DATA_DIR=/var/data you can
//     just run with DATABASE_URL set.
//   - match_history preserves the original `id` so chronological order is
//     stable. The sequence is bumped at the end so subsequent INSERTs
//     don't collide.
//   - The migration SQL must have run first; this script does not create
//     tables.

import Database from "better-sqlite3";
import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");
const SQLITE_PATH =
  process.env.SQLITE_PATH || path.join(DATA_DIR, "elo.db");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set — aborting.");
  process.exit(1);
}
if (!fs.existsSync(SQLITE_PATH)) {
  console.error(`No SQLite file at ${SQLITE_PATH} — nothing to import.`);
  process.exit(0);
}

const sqlite = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true });
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL === "off" ? false : { rejectUnauthorized: false },
});

// Process a SQLite table in chunks so we don't blow up memory on a big
// match_history. 1000 rows per batch is a good compromise between RTT
// overhead and the size of a single transaction.
const BATCH = 1000;

async function copyTable({ table, columns, conflict, sqliteSelect }) {
  const placeholders = columns
    .map((_, i) => `$${i + 1}`)
    .join(", ");
  const insertSql = `
    INSERT INTO ${table} (${columns.join(", ")})
    VALUES (${placeholders})
    ${conflict}
  `;
  const stmt = sqlite.prepare(sqliteSelect || `SELECT * FROM ${table}`);
  const rows = stmt.all();
  console.log(`${table}: ${rows.length} row(s) to import`);
  if (!rows.length) return 0;

  const client = await pool.connect();
  let n = 0;
  try {
    await client.query("BEGIN");
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      for (const row of slice) {
        const params = columns.map((col) => row[col] ?? null);
        await client.query(insertSql, params);
        n++;
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  console.log(`  → ${n} inserted/upserted`);
  return n;
}

async function bumpSequence(table, idColumn) {
  // Set the BIGSERIAL sequence to MAX(id)+1 so subsequent INSERTs in the
  // running server don't collide with imported rows.
  const seqRow = (
    await pool.query(
      `SELECT pg_get_serial_sequence($1, $2) AS seq`,
      [table, idColumn]
    )
  ).rows[0];
  if (!seqRow?.seq) return; // not a serial column
  await pool.query(
    `SELECT setval($1, COALESCE((SELECT MAX(${idColumn}) FROM ${table}), 0))`,
    [seqRow.seq]
  );
  console.log(`  → bumped ${seqRow.seq} to MAX(${table}.${idColumn})`);
}

try {
  await copyTable({
    table: "players",
    columns: [
      "id", "nickname", "elo", "wins", "losses", "draws",
      "created_at", "last_seen",
      "email", "password_hash", "auth_provider",
      "google_sub", "avatar", "avatar_is_custom", "peak_elo",
    ],
    // ON CONFLICT DO NOTHING: re-running the import won't clobber rows
    // that already exist (e.g. accounts created on Postgres after a
    // partial import).
    conflict: "ON CONFLICT (id) DO NOTHING",
  });

  await copyTable({
    table: "mal_popularity",
    columns: [
      "mal_id", "members", "score", "title", "titles",
      "anilist_titles", "fetched_at",
    ],
    // Cache table: re-import refreshes if we ran against a newer SQLite
    // snapshot. Updated_at moves forward.
    conflict: `
      ON CONFLICT (mal_id) DO UPDATE SET
        members        = EXCLUDED.members,
        score          = EXCLUDED.score,
        title          = EXCLUDED.title,
        titles         = EXCLUDED.titles,
        anilist_titles = EXCLUDED.anilist_titles,
        fetched_at     = EXCLUDED.fetched_at
    `,
  });

  await copyTable({
    table: "openings",
    columns: [
      "anime_id", "theme_slug", "anime_slug", "anime_name", "year",
      "song", "video_link", "audio_link", "mal_id", "members", "score",
      "factor", "franchise", "franchise_key", "accepted", "dub_label",
      "updated_at",
    ],
    conflict: `
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
        updated_at    = EXCLUDED.updated_at
    `,
  });

  await copyTable({
    table: "match_history",
    // Preserving id keeps chronological ordering stable across the
    // migration — the recent-matches query ORDER BY id DESC will match
    // exactly what players saw on the old SQLite version.
    columns: [
      "id", "played_at", "anime_name", "mal_id", "outcome",
      "winner_id", "loser_id", "winner_name", "loser_name",
      "winner_elo_before", "winner_elo_after",
      "loser_elo_before", "loser_elo_after", "duration_ms",
    ],
    // (id) is the PK; existing rows with the same id stay untouched.
    conflict: "ON CONFLICT (id) DO NOTHING",
  });
  await bumpSequence("match_history", "id");

  console.log("Import complete.");
} catch (e) {
  console.error("Import failed:", e);
  process.exitCode = 1;
} finally {
  sqlite.close();
  await pool.end();
}
