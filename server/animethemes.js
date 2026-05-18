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

// The animetheme endpoint rejects a nested `anime.resources` include (422),
// so the MAL id is resolved with a second call to the single-anime endpoint,
// whose `resources` relation carries the MyAnimeList external_id.
export async function getMalId(animeSlug) {
  if (!animeSlug) return null;
  try {
    const data = await fetchJSON(
      `${BASE}/anime/${encodeURIComponent(animeSlug)}` +
        `?include=resources&fields[anime]=slug&fields[resource]=external_id,site`
    );
    const mal = (data.anime?.resources || []).find(
      (x) => x.site === "MyAnimeList"
    );
    return mal ? Number(mal.external_id) : null;
  } catch {
    return null; // popularity service falls back to neutral on a null id
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
    `&include=anime,song,animethemeentries.videos` +
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
      out.push({ anime: t.anime, song: t.song, theme: t, video });
      break; // one entry per theme is enough
    }
  }
  if (!out.length) throw new Error("No openings with a playable video");
  return out;
}

// Convenience fallback: a single random opening with its MAL id resolved.
export async function getRandomOpening() {
  const [c] = await getOpeningCandidates(15);
  return { ...c, malId: await getMalId(c.anime.slug) };
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
