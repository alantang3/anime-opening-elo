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
import {
  getPopularity,
  targetFactorForElo,
  minMembersForElo,
} from "./popularity.js";
import { buildAcceptedAnswers } from "./matching.js";
import { dubFranchiseFor, isEnglishDub } from "./dubOverrides.js";
import { pickPooledOpening, poolSize } from "./db.js";

// Once the pool has at least this many rows, rounds are served entirely from
// it (zero API calls). Below it (cold start) we fall back to live fetching.
const MIN_POOL = 60;
const recent = []; // last few anime_ids served, to reduce repeats

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

const PAGE_SIZE = 25;     // candidates fetched per random page (1 API call)
const MAX_PAGES = 3;      // extra random pages if we can't find a mainstream one
const MAX_EVAL = 21;      // hard cap on detail/popularity lookups per round
const BATCH = 3;          // concurrent lookups (gentle on Jikan rate limits)
const TOLERANCE = 0.1;    // |factor - target| within this ⇒ accept early

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
  const minMembers = minMembersForElo(avgElo); // hard mainstream floor (low Elo)

  // Fast path: serve from the local pool — zero API calls, scales freely.
  if (poolSize() >= MIN_POOL) {
    let row = null;
    for (let i = 0; i < 6; i++) {
      const r = pickPooledOpening({ minMembers, target });
      if (!r) break;
      row = r;
      if (!recent.includes(r.animeId)) break; // prefer something not recent
    }
    if (row) {
      recent.push(row.animeId);
      if (recent.length > 40) recent.shift();
      return {
        anime: {
          id: row.animeId,
          name: row.animeName,
          slug: row.animeSlug,
          year: row.year,
        },
        song: row.song ? { title: row.song } : null,
        theme: null,
        video: { link: row.videoLink },
        malId: row.malId,
        popularity: {
          members: row.members,
          score: row.score,
          factor: row.factor,
        },
        accepted: row.accepted || [],
        franchiseKey: row.franchiseKey,
        franchise: row.franchise,
        dub: row.dubLabel ? { label: row.dubLabel } : null,
        targetFactor: round2(target),
        chosenFactor: round2(row.factor),
      };
    }
  }

  // Cold-start fallback: live fetch (the original path) until the ingester
  // has filled the pool.
  const evaluated = [];
  let firstCandidate = null;
  let accepted = null; // a qualifying candidate close to target → stop early

  // Pull random pages until we find a mainstream-enough opening near the
  // target, or run out of pages / our evaluation budget. AnimeThemes is
  // obscure-skewed, so one page often has no popular show — hence the retry.
  for (let page = 0; page < MAX_PAGES && !accepted; page++) {
    let candidates;
    try {
      candidates = await getOpeningCandidates(PAGE_SIZE);
    } catch {
      break;
    }
    if (!firstCandidate && candidates[0]) firstCandidate = candidates[0];

    const pool = candidates.slice(0, MAX_EVAL - evaluated.length);
    for (let i = 0; i < pool.length && !accepted; i += BATCH) {
      const slice = pool.slice(i, i + BATCH);
      const got = await Promise.all(
        slice.map((c) => evaluate(c).catch(() => null))
      );
      for (const e of got) {
        if (!e) continue;
        evaluated.push(e);
        const mainstreamEnough =
          minMembers === 0 ||
          (Number.isFinite(e.popularity?.members) &&
            e.popularity.members >= minMembers);
        if (mainstreamEnough && Math.abs(e.factor - target) <= TOLERANCE) {
          accepted = e;
          break;
        }
      }
      if (evaluated.length >= MAX_EVAL) break;
    }
  }

  const chosen = chooseBest(evaluated, target, minMembers, accepted);
  if (chosen) return enrich(chosen, target, chosen.factor);

  // Nothing could be evaluated (AnimeThemes/Jikan all failing): fall back to
  // the first candidate so a round can still start.
  if (!firstCandidate) throw new Error("no openings available");
  const detail = await getAnimeDetail(firstCandidate.anime.slug).catch(() => ({}));
  const popularity = await getPopularity(detail.malId);
  return enrich(
    { ...firstCandidate, detail, malId: detail.malId, popularity },
    target,
    null
  );
}

// Prefer candidates that clear the mainstream members floor, and among those
// the one closest to the difficulty target. If NONE clear the floor (a
// low-Elo player and every page was too obscure), serve the single most
// popular show we saw — never an obscure one.
function chooseBest(evaluated, target, minMembers, accepted) {
  if (accepted) return accepted;
  if (!evaluated.length) return null;

  const qualifying =
    minMembers === 0
      ? evaluated
      : evaluated.filter(
          (e) =>
            Number.isFinite(e.popularity?.members) &&
            e.popularity.members >= minMembers
        );

  if (qualifying.length) {
    return qualifying.reduce((b, e) =>
      Math.abs(e.factor - target) < Math.abs(b.factor - target) ? e : b
    );
  }
  // Couldn't meet the floor → the most popular thing we found (min factor).
  return evaluated.reduce((b, e) => (e.factor < b.factor ? e : b));
}
const round2 = (x) => Math.round(x * 100) / 100;
