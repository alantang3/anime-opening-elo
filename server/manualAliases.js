// Hand-curated aliases for shows whose famous nickname / acronym our
// automatic alias generation can't produce.
//
// The auto-generated accepted set is built from the full title + Jikan
// synonyms + season-stripped variants + first-letter acronyms. Some
// shows defeat that automation in three recurring ways:
//
//   1) The famous handle is a SUBSTRING of the long title with no
//      subtitle delimiter to split on — e.g. "Bunny Girl Senpai" inside
//      "Seishun Buta Yarou wa Bunny Girl Senpai no Yume wo Minai".
//   2) The famous handle is a partial title with the GENRE PREFIX
//      dropped — e.g. "Madoka Magica" instead of "Mahou Shoujo Madoka
//      Magica" or "Puella Magi Madoka Magica".
//   3) The famous acronym comes from a compound-word SPLIT, not
//      first-letters — e.g. "CSM" for Chainsaw Man (chain-saw-man),
//      where auto-generated acronym would be "cm" (and gets dropped by
//      the >=3-char minimum anyway).
//
// Format: each rule has a `matches` regex run against the NORMALIZED
// form of every input name (athName / seriesName / synonyms / Jikan
// titles). If any name matches, all `aliases` get added to the
// franchise's accepted set. Aliases are run through the same alias
// pipeline (addOne) so they get markers stripped + acronym generated
// like everything else.
//
// Write `matches` for normalized text: lowercase, no diacritics, no
// punctuation, single-spaced.

export const MANUAL_ALIASES = [
  // Chainsaw Man — fans say CSM (chain-saw-man split). Auto acronym
  // would be "cm" which is too short anyway and too generic.
  { matches: /\bchainsaw man\b/, aliases: ["csm", "chainsawman"] },

  // Madoka Magica — the prefix "Mahou Shoujo" / "Puella Magi" gets
  // dropped in casual reference.
  { matches: /\bmadoka magica\b/, aliases: ["madoka magica", "madoka"] },

  // Bunny Girl Senpai — the substring everyone calls the show by,
  // unreachable from the full Japanese title by any auto rule.
  { matches: /\bbunny girl senpai\b/, aliases: ["bunny girl senpai"] },

  // Haikyu(u) — also covered by the splitSubtitle "!! " delimiter
  // improvement, but explicit here in case future titles format
  // differently. Matches both "haikyuu" and "haikyu" spellings.
  { matches: /\bhaikyu+\b/, aliases: ["haikyuu", "haikyu"] },

  // Noragami — sequel "Noragami Aragoto" has no subtitle delimiter and
  // AnimeThemes' series field isn't reliably set for it, so neither
  // auto layer catches the franchise base. "noragami" alone is what
  // fans actually type. Matching `noragami` (which trivially matches
  // both seasons' titles) keeps this one rule covering both.
  { matches: /\bnoragami\b/, aliases: ["noragami"] },

  // Saiki K — auto-generated acronyms come out "sknpn" / "dlosk", and
  // substring match of "saiki k" against the full English title is
  // blocked by the >=2-substantive-words guard (the "k" is one char).
  // Add the fan-standard forms explicitly. Match either the Japanese
  // ("saiki kusuo") or English ("saiki k") name so any source brings
  // in all variants.
  {
    matches: /\bsaiki (kusuo|k)\b/,
    aliases: ["saiki k", "saiki", "saikik"],
  },

  // JoJo — every season is "JoJo's Bizarre Adventure: <subtitle>" or
  // its Japanese name "JoJo no Kimyou na Bouken". The subtitle split
  // already lands the franchise root in the set, but fans
  // overwhelmingly just type "jojo". Matches against the normalized
  // form (apostrophes are stripped in normalize), so we check both
  // "jojos bizarre" (English) and "jojo no kimyou" (Japanese) — either
  // identifies the franchise.
  {
    matches: /\b(jojos? bizarre|jojo no kimyou)\b/,
    aliases: ["jojo", "jojos"],
  },
];
