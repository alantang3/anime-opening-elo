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

import {
  getOpeningCandidates,
  getAnimeDetail,
  getOpeningThemes,
} from "./animethemes.js";
import { getPopularity, targetFactorForElo } from "./popularity.js";
import { buildAcceptedAnswers } from "./matching.js";
import { dubFranchiseFor, isEnglishDub } from "./dubOverrides.js";

// Pokémon / Digimon Adventure play an English ("-EN") opening: ANY of the
// show's English OPs is picked at random. If the show has no English OP at
// all, fall back to the Japanese opening that was drawn.
export async function resolveVideo(e) {
  const fr = dubFranchiseFor(e.anime?.name);
  if (!fr) return { link: e.video?.link, dub: null };

  const themes = await getOpeningThemes(e.anime?.slug);
  const english = themes.filter((t) => isEnglishDub(t.slug, t.link));
  if (english.length) {
    const pick = english[Math.floor(Math.random() * english.length)];
    return { link: pick.link, dub: { label: fr.label, key: fr.key } };
  }
  return { link: e.video?.link, dub: null }; // no English OP → Japanese
}

const PAGE_SIZE = 20;     // candidates fetched per round (1 AnimeThemes call)
const MAX_EVAL = 12;      // hard cap on detail/popularity lookups per round
const BATCH = 3;          // concurrent lookups (gentle on Jikan rate limits)
const TOLERANCE = 0.12;   // |factor - target| within this ⇒ accept early

// One AnimeThemes detail call (series + synonyms + MAL id) + one Jikan call
// (popularity + title variants). Both are cached, so this gets cheap.
async function evaluate(c) {
  const detail = await getAnimeDetail(c.anime.slug);
  const pop = await getPopularity(detail.malId);
  return { ...c, detail, malId: detail.malId, popularity: pop, factor: pop.factor };
}

// Attach the franchise-level accepted-answer set + resolve the audio
// (Japanese by default; English dub for Pokémon / Digimon Adventure).
async function enrich(e, target, chosenFactor) {
  const { accepted, franchiseKey } = buildAcceptedAnswers({
    athName: e.anime?.name,
    seriesName: e.detail?.seriesName,
    seriesSlug: e.detail?.seriesSlug,
    synonyms: e.detail?.synonyms || [],
    jikanTitles: e.popularity?.titles || [],
  });
  const resolved = await resolveVideo(e);
  const dub = resolved.dub;
  const video = { ...e.video, link: resolved.link };
  return {
    anime: e.anime,
    song: e.song,
    theme: e.theme,
    video,
    malId: e.malId,
    popularity: e.popularity,
    accepted,
    franchiseKey,
    franchise: e.detail?.seriesName || e.anime?.name || null,
    dub,
    targetFactor: round2(target),
    chosenFactor: chosenFactor == null ? null : round2(chosenFactor),
  };
}

/**
 * @param {number} avgElo  mean Elo of the two matched players
 * @returns opening = { anime, song, theme, video, malId, popularity,
 *          accepted:string[], franchise, franchiseKey, targetFactor,
 *          chosenFactor }
 */
export async function pickOpeningForElo(avgElo) {
  const target = targetFactorForElo(avgElo);
  const candidates = await getOpeningCandidates(PAGE_SIZE);

  let best = null; // { ...evaluated, dist }
  const pool = candidates.slice(0, MAX_EVAL);

  for (let i = 0; i < pool.length && !withinTolerance(best); i += BATCH) {
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

  if (best) return enrich(best, target, best.factor);

  // Nothing could be evaluated (AnimeThemes/Jikan all failing): fall back to
  // the first candidate so a round can still start.
  const c = candidates[0];
  const detail = await getAnimeDetail(c.anime.slug).catch(() => ({}));
  const popularity = await getPopularity(detail.malId);
  return enrich(
    { ...c, detail, malId: detail.malId, popularity },
    target,
    null
  );
}

function withinTolerance(best) {
  return best && best.dist <= TOLERANCE;
}
const round2 = (x) => Math.round(x * 100) / 100;
