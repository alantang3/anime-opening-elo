// Background ingester: trickle-fills the `openings` pool by walking MAL's
// by-popularity ranking (most members first) and resolving each show to its
// AnimeThemes OPs. The pool therefore fills in the SAME order the difficulty
// floor uses (members) — no random sampling, no hardcoded titles — so the
// most-played (low/mid Elo) tiers are satisfied first. Round selection then
// reads only the local DB (zero API calls).

import {
  getAnimeDetail,
  getAnimeOpenings,
  animeSlugForMalId,
} from "./animethemes.js";
import { getPopularityPage, membersToFactor } from "./popularity.js";
import { buildAcceptedAnswers } from "./matching.js";
import { getAnilistTitles } from "./anilist.js";
import { dubFranchiseFor, isEnglishDub } from "./dubOverrides.js";
import {
  upsertOpening,
  poolSize,
  backfillOpeningsFromCache,
} from "./db.js";

const ITEMS_PER_TICK = 4;       // anime resolved per tick
const ITEM_DELAY_MS = 2_000;    // gap between per-anime API resolves
const TICK_WARM_MS = 60_000;    // gap between ticks once the pool is healthy
const TICK_COLD_MS = 8_000;     // faster (still safe) while the pool is small
const COLD_POOL = 300;          // below this, fill quicker

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let running = false;

// Popularity-walk cursor. A Jikan page (~25 anime) is fetched once and then
// consumed a few per tick; when exhausted we advance, wrapping back to the
// top at the end so members stay refreshed over time.
let popPage = 1;
let popIdx = 0;
let pageEntries = [];
let pageHasNext = false;

// Resolve one MAL-popular anime to its AnimeThemes OPs and store every one.
// Returns the number of rows upserted (0 if it can't be pooled).
async function ingestPopular(entry) {
  if (entry?.members == null) return 0; // unknown popularity → skip
  const slug = await animeSlugForMalId(entry.malId);
  if (!slug) return 0; // not catalogued on AnimeThemes
  const res = await getAnimeOpenings(slug);
  if (!res || !res.themes.length) return 0; // no OPs *or* EDs catalogued — skip
  const detail = await getAnimeDetail(slug); // series/synonyms for matching
  // AniList synonyms (fan handles like "AoT", "BNHA") — cached after
  // first hit. The pool ingester paces itself with sleep(2000) between
  // anime so adding one more API call here is well within AniList's
  // 90/min unauth rate limit.
  const anilistTitles = await getAnilistTitles(entry.malId);

  const { accepted, franchiseKey } = buildAcceptedAnswers({
    athName: res.anime.name,
    seriesName: detail?.seriesName,
    seriesSlug: detail?.seriesSlug,
    synonyms: detail?.synonyms || [],
    jikanTitles: [...(entry.titles || []), ...anilistTitles],
  });
  const common = {
    animeId: Number(res.anime.id),
    animeSlug: res.anime.slug,
    animeName: res.anime.name,
    year: res.anime.year,
    malId: entry.malId,
    members: entry.members,
    score: entry.score,
    factor: membersToFactor(entry.members),
    franchise: detail?.seriesName || res.anime.name || null,
    franchiseKey,
    accepted,
  };

  const fr = dubFranchiseFor(res.anime.name);
  if (fr) {
    // Dub franchise (Pokémon / Digimon) → store its English ("-EN") OPs.
    const english = res.themes.filter((t) => isEnglishDub(t.slug, t.link));
    if (english.length) {
      for (const t of english)
        await upsertOpening({
          ...common,
          themeSlug: t.slug,
          song: null,
          videoLink: t.link,
          audioLink: t.audio || null,
          dubLabel: fr.label,
        });
      return english.length;
    }
  }
  // Non-dub: store EVERY OP theme of the show, so a 9-OP series contributes
  // all 9 (selection weights by show, then picks one at random).
  const ops = res.themes.filter((t) => !isEnglishDub(t.slug, t.link));
  const list = ops.length ? ops : res.themes;
  for (const t of list)
    await upsertOpening({
      ...common,
      themeSlug: t.slug,
      song: t.song,
      videoLink: t.link,
      audioLink: t.audio || null,
      dubLabel: null,
    });
  return list.length;
}

async function tick() {
  // Refill the cursor from the next popularity page when the current one is
  // spent (one Jikan call per ~25 anime, not per tick).
  if (popIdx >= pageEntries.length) {
    let res;
    try {
      res = await getPopularityPage(popPage);
    } catch {
      return false; // Jikan hiccup — back off, retry later
    }
    pageEntries = res.entries || [];
    pageHasNext = res.hasNext;
    popIdx = 0;
    popPage = pageHasNext && pageEntries.length ? popPage + 1 : 1; // wrap
    if (!pageEntries.length) return false;
  }

  let n = 0;
  const slice = pageEntries.slice(popIdx, popIdx + ITEMS_PER_TICK);
  popIdx += slice.length;
  for (const entry of slice) {
    try {
      n += await ingestPopular(entry);
    } catch {
      /* skip this one; never let the ingester throw */
    }
    await sleep(ITEM_DELAY_MS);
  }

  // Rescue any rows whose members were frozen NULL but are now in the cache.
  try {
    const fixed = await backfillOpeningsFromCache(membersToFactor);
    if (fixed) console.log(`Pool backfill: fixed ${fixed} null-members row(s)`);
  } catch {
    /* never let the ingester throw */
  }
  return n > 0;
}

export async function startIngester() {
  if (running) return;
  running = true;
  // Immediately rescue rows poisoned before the skip-NULL fix shipped.
  try {
    const fixed = await backfillOpeningsFromCache(membersToFactor);
    if (fixed)
      console.log(`Pool backfill (startup): fixed ${fixed} null-members row(s)`);
  } catch {
    /* non-fatal */
  }
  const loop = async () => {
    let ok = false;
    try {
      ok = await tick();
    } catch {
      ok = false;
    }
    const small = (await poolSize()) < COLD_POOL;
    const next = !ok ? TICK_WARM_MS : small ? TICK_COLD_MS : TICK_WARM_MS;
    setTimeout(loop, next).unref?.();
  };
  console.log(`Opening ingester started (pool: ${await poolSize()})`);
  loop();
}
