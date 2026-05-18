// Difficulty-targeted opening selection.
//
// Matchmaking itself is pure FIFO (it does NOT consider Elo). Elo only
// influences WHICH opening plays: we take the two players' average rating,
// turn it into a target popularity factor, then pick the candidate whose
// popularity is closest to that target. Beginners get household-name shows;
// only high-rated pairs get pushed toward obscure deep cuts (which, via
// elo.js, are also worth the most points).
//
// AnimeThemes exposes no popularity signal in its listing and MAL popularity
// needs a per-anime Jikan call, so we over-sample one random page and
// evaluate a bounded number of candidates (cheap once popularity.js has
// warmed its SQLite cache). Everything degrades gracefully: worst case it
// behaves like the old uniformly-random pick.

import { getOpeningCandidates, getMalId } from "./animethemes.js";
import { getPopularity, targetFactorForElo } from "./popularity.js";

const PAGE_SIZE = 20;     // candidates fetched per round (1 AnimeThemes call)
const MAX_EVAL = 12;      // hard cap on popularity lookups per round
const BATCH = 3;          // concurrent lookups (gentle on Jikan rate limits)
const TOLERANCE = 0.12;   // |factor - target| within this ⇒ accept early

async function evaluate(c) {
  const malId = await getMalId(c.anime.slug);
  const pop = await getPopularity(malId);
  return { ...c, malId, popularity: pop, factor: pop.factor };
}

/**
 * @param {number} avgElo  mean Elo of the two matched players
 * @returns opening = { anime, song, theme, video, malId, popularity }
 *          plus { targetFactor, chosenFactor } for logging/telemetry.
 */
export async function pickOpeningForElo(avgElo) {
  const target = targetFactorForElo(avgElo);
  const candidates = await getOpeningCandidates(PAGE_SIZE);

  let best = null; // { ...evaluated, dist }
  const pool = candidates.slice(0, MAX_EVAL);

  for (let i = 0; i < pool.length && !accepted(best); i += BATCH) {
    const slice = pool.slice(i, i + BATCH);
    const evaluated = await Promise.all(
      slice.map((c) => evaluate(c).catch(() => null))
    );
    for (const e of evaluated) {
      if (!e) continue;
      const dist = Math.abs(e.factor - target);
      if (!best || dist < best.dist) best = { ...e, dist };
      if (dist <= TOLERANCE) break;
    }
  }

  if (best) {
    return {
      anime: best.anime,
      song: best.song,
      theme: best.theme,
      video: best.video,
      malId: best.malId,
      popularity: best.popularity,
      targetFactor: round2(target),
      chosenFactor: round2(best.factor),
    };
  }

  // Nothing could be evaluated (AnimeThemes/Jikan all failing): fall back to
  // the first playable candidate with neutral popularity so a round can still
  // start.
  const c = candidates[0];
  const malId = await getMalId(c.anime.slug).catch(() => null);
  return {
    anime: c.anime,
    song: c.song,
    theme: c.theme,
    video: c.video,
    malId,
    popularity: await getPopularity(malId),
    targetFactor: round2(target),
    chosenFactor: null,
  };
}

function accepted(best) {
  return best && best.dist <= TOLERANCE;
}
const round2 = (x) => Math.round(x * 100) / 100;
