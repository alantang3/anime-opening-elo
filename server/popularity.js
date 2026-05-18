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
// shows; difficulty ramps up as raw Elo climbs toward HARD_ELO, and only
// strong players reach the obscure deep cuts. The ramp is a function of the
// player pair's average Elo rating (not games played) — wins push that rating
// up faster than losses pull it down (see elo.js), so the climb is gentle.
const EASY_ELO = 100; // start / floor → most popular
const HARD_ELO = 4000; // at/above this → most obscure
const MIN_TARGET = 0.05;
const MAX_TARGET = 0.9;

export function targetFactorForElo(avgElo) {
  const e = Number.isFinite(avgElo) ? avgElo : EASY_ELO;
  const t = clamp((e - EASY_ELO) / (HARD_ELO - EASY_ELO), 0, 1); // 0 easy…1 hard
  return clamp(MIN_TARGET + t * (MAX_TARGET - MIN_TARGET), 0.05, 0.95);
}

// A HARD minimum MAL member count as an explicit function of the pair's
// average Elo. Modeled as an exponential decay with a fixed HALF-LIFE in Elo
// points: starting from MEMBERS_HI at Elo 100, the required member count
// halves every HALF_LIFE_ELO of rating, asymptoting toward MEMBERS_LO (≈ no
// floor). This is the single knob for difficulty pacing — a bigger half-life
// keeps players on popular shows for longer (slower ramp); smaller is faster.
//
//   minMembers = clamp( MEMBERS_HI · 2 ^ (−(avgElo − EASY_ELO) / HALF_LIFE_ELO),
//                        MEMBERS_LO, MEMBERS_HI )
//
// Resulting curve (members floor → ~count of qualifying shows):
//   Elo  100 → 3.50M (~4)    500 → 2.20M (~30)   1500 → 0.69M (~270)
//        300 → 2.78M (~12)  1000 → 1.24M (~110)  2000 → 0.39M (~480)
//       3000 → 123k         4000 → 39k (deep cuts open up at the very top)
const MEMBERS_HI = 3_500_000; // floor at EASY_ELO (Elo 100): the ubiquitous few
const MEMBERS_LO = 1_000;     // asymptotic floor: effectively no floor
const HALF_LIFE_ELO = 600;    // Elo per halving of the required member count

export function minMembersForElo(avgElo) {
  const e = Number.isFinite(avgElo) ? avgElo : EASY_ELO;
  const m = MEMBERS_HI * Math.pow(2, -(e - EASY_ELO) / HALF_LIFE_ELO);
  return Math.round(clamp(m, MEMBERS_LO, MEMBERS_HI));
}

export { membersToFactor };
