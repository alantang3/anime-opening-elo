// AniList (GraphQL) access for richer title coverage. We already pull from
// AnimeThemes (series + animesynonyms) and Jikan/MAL (title +
// title_english + title_japanese + title_synonyms); AniList's `synonyms`
// array is community-curated and often carries fan handles the other two
// don't (e.g. "AoT", "BNHA"). It's not a silver bullet — some shows still
// don't list popular abbreviations (the user flagged that "haikyuu" isn't
// in Haikyuu!!'s AniList synonyms) — but it cheaply broadens coverage
// without per-show maintenance.
//
// Anonymous access only. AniList rate-limits to ~90 req/min unauth, well
// within our usage (one fetch per pooled anime, then cached forever via
// the same mal_popularity row).

import {
  getCachedAnilistTitles,
  cacheAnilistTitles,
} from "./db.js";

const URL = "https://graphql.anilist.co";
const USER_AGENT = "anime-opening-elo/1.0 (multiplayer anime OP guessing game)";

const QUERY = `
  query ($malId: Int) {
    Media(idMal: $malId, type: ANIME) {
      title { romaji english native }
      synonyms
    }
  }
`;

// In-flight dedupe so two concurrent rounds for the same uncached anime
// don't both hit AniList. Mirrors the pattern in popularity.js.
const inflight = new Map();

async function fetchAnilist(malId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ query: QUERY, variables: { malId } }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`AniList ${r.status}`);
    const json = await r.json();
    const m = json?.data?.Media;
    if (!m) return [];
    const titles = [
      m.title?.romaji,
      m.title?.english,
      m.title?.native,
      ...(m.synonyms || []),
    ].filter((s) => s && String(s).trim());
    return [...new Set(titles)];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Get AniList titles + synonyms for a MAL id, cached forever after the
 * first successful fetch. Returns an empty array on failure (or for a
 * MAL id AniList doesn't know about) and caches the empty result so we
 * don't retry persistently-failing IDs in a loop.
 *
 * @param {number|null|undefined} malId
 * @returns {Promise<string[]>}
 */
export async function getAnilistTitles(malId) {
  if (!malId) return [];
  const cached = getCachedAnilistTitles(malId);
  if (cached !== null) return cached;
  if (inflight.has(malId)) return inflight.get(malId);
  const p = (async () => {
    try {
      const titles = await fetchAnilist(malId);
      cacheAnilistTitles(malId, titles);
      return titles;
    } catch {
      // Cache empty on failure to suppress retry storms. If the row
      // doesn't exist yet (no Jikan record), don't cache — let a later
      // Jikan fetch create the row first.
      cacheAnilistTitles(malId, []);
      return [];
    } finally {
      inflight.delete(malId);
    }
  })();
  inflight.set(malId, p);
  return p;
}
