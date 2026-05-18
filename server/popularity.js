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

// Difficulty targeting. Everyone starts at 100 Elo (the floor), so the curve
// is calibrated to that base: at/near 100 you get mainstream, household-name
// shows; difficulty ramps up as you climb, and only strong players reach the
// obscure deep cuts.
// Thresholds are scaled to the big-K Elo system (~+45 avg per win), so the
// ramp is paced by GAMES PLAYED, not raw rating. 100 → ~4000 ≈ a long career
// of dozens of wins before you're seeing the truly obscure deep cuts.
const EASY_ELO = 100; // start / floor → most popular
const HARD_ELO = 4000; // at/above this → most obscure
const MIN_TARGET = 0.05;
const MAX_TARGET = 0.9;

export function targetFactorForElo(avgElo) {
  const e = Number.isFinite(avgElo) ? avgElo : EASY_ELO;
  const t = clamp((e - EASY_ELO) / (HARD_ELO - EASY_ELO), 0, 1); // 0 easy…1 hard
  return clamp(MIN_TARGET + t * (MAX_TARGET - MIN_TARGET), 0.05, 0.95);
}

// A HARD minimum MAL member count that decreases linearly with Elo. The top
// ~500 shows already have >500k members and include plenty a casual wouldn't
// know, so Elo 100 requires ~1M+ (strictly the shows "everyone" knows). The
// bar eases as Elo rises and only reaches 0 at FLOOR_FADES_BY, which is set
// equal to HARD_ELO (4000) so even Elo 3000 still has a real threshold
// (~256k members) before deep cuts unlock at the very top.
const MAINSTREAM_MEMBERS = 1_000_000; // floor at Elo 100 (truly ubiquitous)
const FLOOR_FADES_BY = 4000; // Elo at which the members floor reaches 0

export function minMembersForElo(avgElo) {
  const e = Number.isFinite(avgElo) ? avgElo : EASY_ELO;
  const t = clamp((e - EASY_ELO) / (FLOOR_FADES_BY - EASY_ELO), 0, 1);
  return Math.round(MAINSTREAM_MEMBERS * (1 - t));
}

export { membersToFactor };
