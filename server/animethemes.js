// AnimeThemes.moe access. It sits behind Cloudflare, which 403s requests
// that lack a descriptive User-Agent (the default Node fetch UA is blocked).

const BASE = "https://api.animethemes.moe";
const USER_AGENT = "anime-opening-elo/1.0 (multiplayer anime OP guessing game)";

async function fetchJSON(url) {
  const r = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!r.ok) throw new Error(`AnimeThemes ${r.status}: ${url}`);
  return r.json();
}

// The animetheme listing can't deep-include anime.resources (422), so we
// make one follow-up call to the single-anime endpoint. That one call gives
// us everything we need for both popularity (MAL id via `resources`) and
// franchise guess-matching (`series` name + `animesynonyms` English/Native
// titles). One request per evaluated candidate, not several.
export async function getAnimeDetail(animeSlug) {
  const empty = { malId: null, name: null, synonyms: [], seriesName: null, seriesSlug: null };
  if (!animeSlug) return empty;
  try {
    const data = await fetchJSON(
      `${BASE}/anime/${encodeURIComponent(animeSlug)}` +
        `?include=series,animesynonyms,resources`
    );
    const a = data.anime || {};
    const mal = (a.resources || []).find((x) => x.site === "MyAnimeList");
    return {
      malId: mal ? Number(mal.external_id) : null,
      name: a.name ?? null,
      synonyms: (a.animesynonyms || [])
        .map((s) => s.text)
        .filter(Boolean),
      seriesName: a.series?.name ?? null,
      seriesSlug: a.series?.slug ?? null,
    };
  } catch {
    return empty; // popularity falls back to neutral; matcher uses what it has
  }
}

// Fetch a random page of OPs and return every one that has a playable video.
// MAL id is deliberately NOT resolved here — the caller picks a subset by
// difficulty (see selectOpening.js) and only resolves popularity for those,
// keeping the per-anime API calls bounded. sort=random varies each call.
export async function getOpeningCandidates(pageSize = 20) {
  const url =
    `${BASE}/animetheme` +
    `?filter[type]=OP` +
    `&include=anime,song,animethemeentries.videos.audio` +
    `&page[size]=${pageSize}` +
    `&sort=random`;
  const data = await fetchJSON(url);
  const out = [];

  for (const t of data.animethemes || []) {
    if (!t.anime) continue;
    for (const entry of t.animethemeentries || []) {
      // Prefer the highest-resolution encode available.
      const video = [...(entry.videos || [])].sort(
        (a, b) => (b.resolution || 0) - (a.resolution || 0)
      )[0];
      if (!video?.link) continue;
      out.push({
        anime: t.anime,
        song: t.song,
        theme: t,
        video,
        audio: video.audio?.link || null,
      });
      break; // one entry per theme is enough
    }
  }
  if (!out.length) throw new Error("No openings with a playable video");
  return out;
}

// All OP themes for one anime as { slug, link }, best encode per theme.
// Used to find a show's English ("-EN") opening for the dub franchises.
export async function getOpeningThemes(animeSlug) {
  if (!animeSlug) return [];
  try {
    const data = await fetchJSON(
      `${BASE}/anime/${encodeURIComponent(animeSlug)}` +
        `?include=animethemes.animethemeentries.videos`
    );
    const out = [];
    for (const t of data.anime?.animethemes || []) {
      if (t.type !== "OP") continue;
      for (const entry of t.animethemeentries || []) {
        const video = [...(entry.videos || [])].sort(
          (a, b) => (b.resolution || 0) - (a.resolution || 0)
        )[0];
        if (video?.link) {
          out.push({ slug: t.slug, link: video.link });
          break;
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

// In-memory cache for getThemeMediaLinks, keyed by anime+theme slug
// pair. The alt-list for a given (slug, themeSlug) doesn't change
// match-to-match, but today the lazy on-failure fetch path calls
// AnimeThemes again for every match that hits a failure on the same
// show. At scale that's a real API-load problem; cached, each combo
// hits AnimeThemes at most once per server lifetime. Stores the
// PROMISE (not just the resolved value) so concurrent matches racing
// the first request for the same combo dedupe into one network call.
const themeLinksCache = new Map();

/**
 * Cached wrapper around getThemeMediaLinks. Safe to call eagerly at
 * round-prepare — the first hit per (slug, themeSlug) goes to network,
 * every subsequent call is a synchronous Map lookup returning the same
 * resolved promise.
 *
 * @param {string} animeSlug
 * @param {string|null} themeSlug
 * @returns {Promise<Array<{video:string, audio:string|null}>>}
 */
export function getCachedThemeMediaLinks(animeSlug, themeSlug) {
  if (!animeSlug) return Promise.resolve([]);
  const key = `${animeSlug}::${themeSlug || ""}`;
  let p = themeLinksCache.get(key);
  if (!p) {
    p = getThemeMediaLinks(animeSlug, themeSlug).catch(() => []);
    themeLinksCache.set(key, p);
  }
  return p;
}

// Every playable media link for one SPECIFIC theme of an anime, as
// {video, audio} pairs. Order is the fallback chain WITHIN that theme:
//   - All entries (versions) of the SAME theme slug — different edits
//     v1/v2/etc. of the same song.
//   - Within each entry: every encoding (NC/BD/WEB/etc.), highest-
//     resolution first.
// Deliberately STRICT to the requested themeSlug: we never cross over
// to OP2 if OP1 was the picked opening, because OP2 is a different song
// — playing it would mean the result-page replay shows a different
// track than what played during the round, which is confusing UX. If
// all encodes of the picked theme are dead, the chain bottoms out and
// the round voids cleanly (or, at RESULT phase, the player just sits
// empty — the round is already settled, no Elo impact).
//
// Each video carries its OWN paired direct audio file (OGG/MP3) when
// AnimeThemes has one; we ship it alongside the video so the client can
// try the lighter audio file before the full video for each encoding.
// De-duplicated by video link.
//
// themeSlug nullability: if it's missing (rare — only when we lost the
// theme slug somehow), we fall back to all OP/ED themes of the show
// rather than returning nothing.
export async function getThemeMediaLinks(animeSlug, themeSlug) {
  if (!animeSlug) return [];
  try {
    const data = await fetchJSON(
      `${BASE}/anime/${encodeURIComponent(animeSlug)}` +
        `?include=animethemes.animethemeentries.videos.audio`
    );
    const themes = (data.anime?.animethemes || []).filter((t) => {
      if (t.type !== "OP" && t.type !== "ED") return false;
      // Strict same-theme: only the picked OP/ED slot. Without a slug we
      // can't be strict, so accept any OP/ED as a degraded fallback.
      return !themeSlug || t.slug === themeSlug;
    });
    const out = [];
    const seen = new Set();
    for (const t of themes) {
      for (const entry of t.animethemeentries || []) {
        const vids = [...(entry.videos || [])].sort(
          (a, b) => (b.resolution || 0) - (a.resolution || 0)
        );
        for (const v of vids) {
          if (v?.link && !seen.has(v.link)) {
            seen.add(v.link);
            out.push({ video: v.link, audio: v.audio?.link || null });
          }
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Resolve a MAL id to its AnimeThemes slug via the resource endpoint
// (confirmed reliable: MAL 16498 → "shingeki_no_kyojin"). null if AnimeThemes
// has no entry for that MAL id (e.g. a movie / not catalogued).
export async function animeSlugForMalId(malId) {
  if (!malId) return null;
  try {
    const data = await fetchJSON(
      `${BASE}/resource` +
        `?filter%5Bsite%5D=MyAnimeList` +
        `&filter%5Bexternal_id%5D=${encodeURIComponent(malId)}` +
        `&include=anime`
    );
    for (const res of data.resources || []) {
      const a = (res.anime || [])[0];
      if (a?.slug) return a.slug;
    }
    return null;
  } catch {
    return null;
  }
}

// One specific anime (by slug) with its id/name/year and its themes (best
// encode + song title each). Prefers OPs; if the show has no OPs at all
// (movies like Demon Slayer: Mugen Train, Weathering With You, Haikyuu!!
// movies — typically have only an ED) it falls back to EDs so those shows
// can still be pooled. Mixed-content shows still only contribute their OPs.
export async function getAnimeOpenings(slug) {
  if (!slug) return null;
  try {
    const data = await fetchJSON(
      `${BASE}/anime/${encodeURIComponent(slug)}` +
        `?include=animethemes.song,animethemes.animethemeentries.videos.audio`
    );
    const a = data.anime;
    if (!a) return null;
    const collect = (wantType) => {
      const out = [];
      for (const t of a.animethemes || []) {
        if (t.type !== wantType) continue;
        for (const entry of t.animethemeentries || []) {
          const v = [...(entry.videos || [])].sort(
            (x, y) => (y.resolution || 0) - (x.resolution || 0)
          )[0];
          if (v?.link) {
            out.push({
              slug: t.slug,
              song: t.song?.title || null,
              link: v.link,
              audio: v.audio?.link || null, // direct .ogg song (preferred)
            });
            break;
          }
        }
      }
      return out;
    };
    let themes = collect("OP");
    if (!themes.length) themes = collect("ED");
    return { anime: { id: a.id, name: a.name, slug: a.slug, year: a.year }, themes };
  } catch {
    return null;
  }
}

// Convenience fallback: a single random opening with its detail resolved.
export async function getRandomOpening() {
  const [c] = await getOpeningCandidates(15);
  return { ...c, detail: await getAnimeDetail(c.anime.slug) };
}

export async function searchAnime(query) {
  if (!query || query.length < 2) return [];
  const url =
    `${BASE}/anime` +
    `?q=${encodeURIComponent(query)}` +
    `&page[size]=10` +
    `&fields[anime]=id,name,slug,year`;
  const data = await fetchJSON(url);
  return (data.anime || []).map((a) => ({
    id: a.id,
    name: a.name,
    year: a.year,
  }));
}
