// Dub handling.
//
// Everything plays its original Japanese opening, EXCEPT Pokémon and Digimon
// Adventure: those play the English dub when one exists, and fall back to the
// Japanese opening when it doesn't (nothing is ever skipped).
//
// AnimeThemes hosts the dub openings itself — they're separate theme records
// whose slug ends in "-EN" (e.g. Pokemon "OP1-EN" = "Pokémon Theme (Gotta
// Catch'em All)"; "Digimon Adventure" OP1-EN). No external hosting involved.
//
// Detection is a normalized substring match on the anime name, so it covers
// every Pokémon season (Pokemon Best Wishes! = Black & White, Pokemon XY, …)
// while "digimon adventure" stays narrow — other Digimon series (Tamers,
// Frontier, …) keep their Japanese OPs like everything else.

import { normalize } from "./matching.js";

export const DUB_FRANCHISES = [
  { key: "pokemon", label: "Pokémon", match: ["pokemon", "pocket monsters"] },
  {
    key: "digimon_adventure",
    label: "Digimon Adventure",
    match: ["digimon adventure"],
  },
];

// The dub franchise for an anime name, or null if it should stay Japanese.
export function dubFranchiseFor(animeName) {
  const n = normalize(animeName);
  if (!n) return null;
  return (
    DUB_FRANCHISES.find((o) => o.match.some((m) => n.includes(m))) || null
  );
}

// AnimeThemes marks English-dub theme records with a "-EN" slug suffix
// (the video filename carries it too: Pokemon-OP1-EN.webm).
export function isEnglishDub(themeSlug, videoLink) {
  return (
    /-EN(\b|[-_.]|$)/i.test(themeSlug || "") ||
    /-EN[-_.]/i.test(videoLink || "")
  );
}
