// Background ingester: trickle-fills the `openings` pool from AnimeThemes +
// Jikan at a polite, rate-limit-safe pace, INDEPENDENT of how many people
// are playing. Round selection then reads only the local DB (zero API
// calls), so the game stays fast and never hammers the upstream APIs no
// matter the traffic.

import {
  getOpeningCandidates,
  getAnimeDetail,
  getOpeningThemes,
} from "./animethemes.js";
import { getPopularity, membersToFactor } from "./popularity.js";
import { buildAcceptedAnswers } from "./matching.js";
import { dubFranchiseFor, isEnglishDub } from "./dubOverrides.js";
import {
  upsertOpening,
  poolSize,
  backfillOpeningsFromCache,
} from "./db.js";

const PAGE = 25;
const ITEMS_PER_TICK = 4;       // candidates resolved per tick
const ITEM_DELAY_MS = 2_000;    // gap between per-anime API resolves
const TICK_WARM_MS = 60_000;    // gap between pages once the pool is healthy
const TICK_COLD_MS = 8_000;     // faster (still safe) while the pool is small
const COLD_POOL = 300;          // below this, fill quicker

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let running = false;

// Turn one drawn candidate into one or more pool rows and store them.
async function ingestCandidate(c) {
  const detail = await getAnimeDetail(c.anime.slug);
  const pop = await getPopularity(detail.malId);
  // Don't pool a show whose MAL popularity we don't know yet: a NULL would
  // freeze into openings.members and stay invisible to the floor query
  // forever. It'll be re-drawn later; once any Jikan pull succeeds the count
  // is cached for good (mal_popularity) and it pools with a real number.
  // backfillOpeningsFromCache() also rescues rows poisoned before this.
  if (pop?.members == null) return 0;
  const { accepted, franchiseKey } = buildAcceptedAnswers({
    athName: c.anime?.name,
    seriesName: detail?.seriesName,
    seriesSlug: detail?.seriesSlug,
    synonyms: detail?.synonyms || [],
    jikanTitles: pop?.titles || [],
  });
  const common = {
    animeId: Number(c.anime.id),
    animeSlug: c.anime.slug,
    animeName: c.anime?.name,
    year: c.anime?.year,
    malId: detail.malId,
    members: pop?.members,
    score: pop?.score,
    factor: pop?.factor ?? 0.5,
    franchise: detail?.seriesName || c.anime?.name || null,
    franchiseKey,
    accepted,
  };

  const fr = dubFranchiseFor(c.anime?.name);
  if (fr) {
    // Dub franchise → store its English ("-EN") OPs; if it has none, fall
    // back to the Japanese OP that was drawn.
    const themes = await getOpeningThemes(c.anime?.slug);
    const english = themes.filter((t) => isEnglishDub(t.slug, t.link));
    if (english.length) {
      for (const t of english)
        upsertOpening({
          ...common,
          themeSlug: t.slug,
          song: null,
          videoLink: t.link,
          dubLabel: fr.label,
        });
      return english.length;
    }
  }
  // Non-dub: store EVERY OP theme of this anime, not just the one random
  // theme that was drawn — so a show contributes all its openings (Death
  // Note OP1+OP2, every Naruto/BNHA OP, …) instead of one fixed one.
  const themes = await getOpeningThemes(c.anime?.slug);
  const ops = themes.filter((t) => !isEnglishDub(t.slug, t.link));
  const list = ops.length
    ? ops
    : [{ slug: c.theme?.slug || "OP", link: c.video.link }];
  for (const t of list)
    upsertOpening({
      ...common,
      themeSlug: t.slug,
      // Only the drawn theme has a known song title from this candidate.
      song: t.slug === c.theme?.slug ? c.song?.title || null : null,
      videoLink: t.link,
      dubLabel: null,
    });
  return list.length;
}

async function tick() {
  let candidates;
  try {
    candidates = await getOpeningCandidates(PAGE);
  } catch {
    return false; // AnimeThemes hiccup — back off, try later
  }
  let n = 0;
  for (const c of candidates.slice(0, ITEMS_PER_TICK)) {
    try {
      n += await ingestCandidate(c);
    } catch {
      /* skip this one; never let the ingester throw */
    }
    await sleep(ITEM_DELAY_MS);
  }
  // Rescue any rows whose members were frozen NULL but are now in the cache.
  try {
    const fixed = backfillOpeningsFromCache(membersToFactor);
    if (fixed) console.log(`Pool backfill: fixed ${fixed} null-members row(s)`);
  } catch {
    /* never let the ingester throw */
  }
  return n > 0;
}

export function startIngester() {
  if (running) return;
  running = true;
  // Immediately rescue rows poisoned before this fix shipped (don't wait for
  // the first tick, which can be many seconds out).
  try {
    const fixed = backfillOpeningsFromCache(membersToFactor);
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
    const small = poolSize() < COLD_POOL;
    const next = !ok ? TICK_WARM_MS : small ? TICK_COLD_MS : TICK_WARM_MS;
    setTimeout(loop, next).unref?.();
  };
  console.log(`Opening ingester started (pool: ${poolSize()})`);
  loop();
}
