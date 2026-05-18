// Maps an anime's MyAnimeList popularity to an Elo-swing factor.
//
// Rule (from the product spec): the more popular the show, the *less* Elo is
// at stake — correctly naming an obscure OP is impressive; naming the season's
// blockbuster is not. So factor ∈ [0,1] where ~1 = obscure (big swing) and
// ~0 = mega-popular (small swing).
//
// Popularity comes from Jikan (the public MAL API). It's rate-limited, so we
// cache every result in SQLite keyed by MAL id and basically never refetch a
// known show. Any failure falls back to a neutral factor so a round never
// breaks because MAL is slow.

import { getCachedPopularity, cachePopularity } from "./db.js";

const JIKAN = "https://api.jikan.moe/v4/anime";
const USER_AGENT = "anime-opening-elo/1.0 (multiplayer anime OP guessing game)";

// Cached rows older than this are treated as stale and refreshed opportunistically.
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Member-count bounds for the log-scale mapping. ~1k members ≈ very obscure,
// ~3M ≈ the most popular shows on MAL.
const MIN_MEMBERS = 1_000;
const MAX_MEMBERS = 3_000_000;
const LOG_MIN = Math.log10(MIN_MEMBERS);
const LOG_MAX = Math.log10(MAX_MEMBERS);

const NEUTRAL = 0.5; // used when popularity is unknown

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function membersToFactor(members) {
  if (!members || members <= 0) return NEUTRAL;
  const t = (Math.log10(members) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  // t≈0 obscure → factor≈1 ; t≈1 popular → factor≈0
  return clamp(1 - t, 0.05, 1);
}

async function fetchJikan(malId) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`${JIKAN}/${malId}`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Jikan ${r.status}`);
    const { data } = await r.json();
    // All title variants — crucially title_english (the dub/English name:
    // "Pokémon", "My Hero Academia") and title_japanese — for guess matching.
    const titles = [
      data?.title,
      data?.title_english,
      data?.title_japanese,
      ...(data?.title_synonyms || []),
    ].filter((s) => s && String(s).trim());
    return {
      members: data?.members ?? null,
      score: data?.score ?? null,
      title: data?.title ?? null,
      titles: [...new Set(titles)],
    };
  } finally {
    clearTimeout(timer);
  }
}

// In-flight dedupe so two simultaneous rounds on the same (uncached) anime
// don't both hammer Jikan.
const inflight = new Map();

const parseTitles = (json) => {
  try {
    const a = JSON.parse(json || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};

/**
 * @returns {Promise<{factor:number, members:number|null, score:number|null,
 *   title:string|null, titles:string[], source:'cache'|'jikan'|'fallback'}>}
 */
export async function getPopularity(malId) {
  if (!malId) {
    return { factor: NEUTRAL, members: null, score: null, title: null, titles: [], source: "fallback" };
  }

  const cached = getCachedPopularity(malId);
  const fresh =
    cached && Date.now() - new Date(cached.fetched_at).getTime() < TTL_MS;
  if (fresh) {
    return {
      factor: membersToFactor(cached.members),
      members: cached.members,
      score: cached.score,
      title: cached.title,
      titles: parseTitles(cached.titles),
      source: "cache",
    };
  }

  if (inflight.has(malId)) return inflight.get(malId);

  const p = (async () => {
    try {
      const info = await fetchJikan(malId);
      cachePopularity({ malId, ...info });
      return {
        factor: membersToFactor(info.members),
        members: info.members,
        score: info.score,
        title: info.title,
        titles: info.titles,
        source: "jikan",
      };
    } catch {
      // Serve a stale cache row if we have one; else neutral.
      if (cached) {
        return {
          factor: membersToFactor(cached.members),
          members: cached.members,
          score: cached.score,
          title: cached.title,
          titles: parseTitles(cached.titles),
          source: "cache",
        };
      }
      return { factor: NEUTRAL, members: null, score: null, title: null, titles: [], source: "fallback" };
    } finally {
      inflight.delete(malId);
    }
  })();

  inflight.set(malId, p);
  return p;
}

// Difficulty targeting: the average Elo of the two matched players decides
// how obscure the opening should be. Low average → aim for a popular show
// (factor near 0, easy to name); high average → aim for an obscure one
// (factor near 1). Only strong players are pushed toward deep cuts.
const EASY_ELO = 1100; // at/below this, serve the most popular shows
const HARD_ELO = 1800; // at/above this, serve the most obscure
const MIN_TARGET = 0.1;
const MAX_TARGET = 0.9;

export function targetFactorForElo(avgElo) {
  const e = Number.isFinite(avgElo) ? avgElo : 1200;
  const t = (e - EASY_ELO) / (HARD_ELO - EASY_ELO); // 0 easy … 1 hard
  return clamp(MIN_TARGET + t * (MAX_TARGET - MIN_TARGET), 0.05, 0.95);
}

export { membersToFactor };
