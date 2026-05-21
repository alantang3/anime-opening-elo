// Guess matching.
//
// A guess is correct when it names the right *franchise*, not the exact
// AnimeThemes entry. Players may type the English title, the Japanese/romaji
// title, an acronym of either (AoT, SnK, MHA, BNHA), or a specific
// season/movie title of the franchise — all accepted; none required.
//
// Strategy: at round start the server builds a Set of accepted normalized
// strings from every name we can find for the show (AnimeThemes name +
// series + synonyms, Jikan title/title_english/title_japanese/synonyms) plus
// generated acronyms. A guess is correct if its normalized form — or its
// season/movie-stripped base — is in that Set. Matching is exact-after-
// normalization (no fuzzy/edit-distance): this is a competitive Elo game, so
// we prefer broad alias coverage over typo tolerance.

import { MANUAL_ALIASES } from "./manualAliases.js";

// Lowercase, strip diacritics (Pokémon → pokemon), drop punctuation, collapse
// whitespace. Unicode letters/numbers are kept, so Japanese (進撃の巨人) and
// kana survive as a single comparable token.
export function normalize(s) {
  if (s == null) return "";
  return String(s)
    .normalize("NFKC") // fold full-width / compatibility forms
    // Strip Latin diacritics (é→e) but recompose so kana voiced marks
    // (which NFD also splits) stay intact: ポケットモンスター is preserved.
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[&＋+]/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Remove season / part / cour / movie / OVA markers and trailing
// ordinals/roman numerals so any entry in a franchise reduces to its base.
// Deliberately conservative — it does NOT strip arbitrary subtitles or
// colon-parts, so distinct franchises ("Fate Zero" vs "Fate Stay Night")
// don't collapse together and cause false wins.
// \s* (not a literal space) so "Season3" / "進撃の巨人3" strip too — CJK
// titles often have no space before the number.
const MARKER_PATTERNS = [
  /\bthe final season\b/g,
  /\bfinal season\b/g,
  /\bseason\s*\d+\b/g,
  /\b\d+(st|nd|rd|th)\s*season\b/g,
  /\bpart\s*\d+\b/g,
  /\b\d+(st|nd|rd|th)\s*part\b/g,
  /\bcour\s*\d+\b/g,
  /\bs\s*\d+\b/g, // terse "S2" / "S 3" season shorthand
  /\bthe movie\b/g,
  /\bmovie\s*\d+\b/g,
  /\bmovies?\b/g,
  /\bovas?\b/g,
  /\boads?\b/g,
  /\bspecials?\b/g,
  /\brecap\b/g,
  /\b(2nd|3rd|4th|5th|6th)\b/g,
  /\s(ii|iii|iv|v|vi|vii|viii|ix|x)$/g, // trailing roman numeral
];

export function stripMarkers(normalized) {
  let out = normalized;
  for (const re of MARKER_PATTERNS) out = out.replace(re, " ");
  // Drop a trailing sequel number ("...3", "... 3", "進撃の巨人3"). The full
  // (unstripped) form is still kept in the accepted set, so exact titles
  // like "Mob Psycho 100" continue to match — only the franchise base loses
  // the number.
  out = out.replace(/\s*\d+$/, "");
  return out.replace(/\s+/g, " ").trim();
}

const hasLatin = (s) =>
  /[a-z]/i.test(s) &&
  !/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(s);

// Digit ↔ word conversion so "7 Deadly Sins" matches "Seven Deadly
// Sins" and vice versa. Anime titles use both interchangeably: official
// English may be "Seven Deadly Sins" while fans type "7 deadly sins"
// (or the title itself is "Re:Zero" written as "Re 0"). Covered up to
// 12 — that's where the long tail of season/sequel numbers lives.
const NUM_TO_WORD = {
  "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
  "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
  "10": "ten", "11": "eleven", "12": "twelve",
};
const WORD_TO_NUM = Object.fromEntries(
  Object.entries(NUM_TO_WORD).map(([d, w]) => [w, d])
);
const WORD_NUMS_RE = new RegExp(
  `\\b(${Object.keys(WORD_TO_NUM).join("|")})\\b`,
  "g"
);
// \b\d+\b avoids matching "2nd" / "3rd" embedded in compound tokens;
// stripMarkers handles those separately. Pure standalone digits only.
function digitsToWords(s) {
  return s.replace(/\b\d+\b/g, (m) => NUM_TO_WORD[m] || m);
}
function wordsToDigits(s) {
  return s.replace(WORD_NUMS_RE, (m) => WORD_TO_NUM[m] || m);
}

// First letter of every word, particles included, because that's how fans
// actually abbreviate: Shingeki no Kyojin → snk, Attack on Titan → aot,
// Kimetsu no Yaiba → kny, Boku no Hero Academia → bnha.
export function acronym(normalized) {
  if (!normalized || !hasLatin(normalized)) return null;
  const words = normalized.split(" ").filter(Boolean);
  if (words.length < 2) return null;
  const a = words.map((w) => w[0]).join("");
  return a.length >= 3 && a.length <= 6 ? a : null;
}

// Drop a leading article so "The Rising of the Shield Hero" and "Rising of
// the Shield Hero" are interchangeable (only the FIRST word).
const stripArticle = (n) => n.replace(/^(?:the|a|an) /, "").trim();

function addForm(set, n) {
  if (n.length >= 2) set.add(n);
  const b = stripMarkers(n);
  if (b.length >= 2) set.add(b);
  // Digit/word swaps on both — so "Seven Deadly Sins" also lands as
  // "7 deadly sins" (and vice versa), and the franchise-base variants
  // get the same treatment. Cheap: only adds when the swap actually
  // changed something.
  for (const base of [n, b]) {
    if (!base) continue;
    const w = digitsToWords(base);
    if (w !== base && w.length >= 2) set.add(w);
    const d = wordsToDigits(base);
    if (d !== base && d.length >= 2) set.add(d);
  }
  // Acronym from BOTH the full name and the franchise base, so a season
  // title ("Attack on Titan Season 3") still yields the franchise acronym
  // "aot", not just "aots3".
  for (const ac of [acronym(n), acronym(b)]) if (ac) set.add(ac);
}

function addOne(set, raw) {
  const n = normalize(raw);
  addForm(set, n);
  const na = stripArticle(n);
  if (na !== n && na.length >= 2) addForm(set, na);
}

// Split a raw title at its first SUBTITLE delimiter:
//   - colon (incl. full-width)
//   - em/en dash with optional spaces
//   - SPACED hyphen (not in-word, so "Kaguya-sama" stays whole)
//   - one-or-more "!" / "?" followed by space ("Haikyuu!! Karasuno...",
//     "Working!! Wagnaria…"). Without this, franchise names that end in
//     emphatic punctuation never reduce to their root.
// Returns [franchiseRoot, subtitle], either possibly "".
function splitSubtitle(raw) {
  const s = String(raw || "");
  const m = s.match(/\s*:\s*|\s*：\s*|\s*[—–]\s*|\s+-\s+|!+\s+|\?+\s+/);
  if (!m) return ["", ""];
  return [s.slice(0, m.index).trim(), s.slice(m.index + m[0].length).trim()];
}

function addName(set, raw) {
  addOne(set, raw);
  // Players name the FRANCHISE, which is the part before the subtitle:
  // "Code Geass: Hangyaku no Lelouch" → "code geass"; "Demon Slayer:
  // Kimetsu no Yaiba Swordsmith Village Arc" → "demon slayer". Strictly
  // additive — only ever makes more correct, never fewer.
  const [root, sub] = splitSubtitle(raw);
  if (root && normalize(root).length >= 3) addOne(set, root);
  // The subtitle too ("Kaguya-sama: Love Is War" → "love is war"), but only
  // when it's a real name — season/part/movie markers strip to nothing.
  if (sub) {
    const sn = stripMarkers(normalize(sub));
    if (sn.length >= 3 && /\p{L}/u.test(sn)) addOne(set, sub);
  }
}

/**
 * @param {object} src
 * @param {string}   src.athName      AnimeThemes anime name (romaji)
 * @param {string}  [src.seriesName]  AnimeThemes series (franchise) name
 * @param {string}  [src.seriesSlug]  AnimeThemes series slug (franchise key)
 * @param {string[]}[src.synonyms]    AnimeThemes synonym texts
 * @param {string[]}[src.jikanTitles] Jikan title/english/japanese/synonyms
 * @returns {{ accepted: string[], franchiseKey: string }}
 */
export function buildAcceptedAnswers({
  athName,
  seriesName,
  seriesSlug,
  synonyms = [],
  jikanTitles = [],
}) {
  const set = new Set();
  const all = [athName, seriesName, ...synonyms, ...jikanTitles].filter(
    Boolean
  );
  for (const name of all) addName(set, name);

  // Manual alias overlay: shows whose famous handle / acronym can't be
  // derived from any source title by the automatic rules (substrings
  // with no delimiter, dropped genre prefixes, compound-word acronyms).
  // See manualAliases.js for the full list and rationale.
  const allNormalized = all.map(normalize);
  for (const rule of MANUAL_ALIASES) {
    if (allNormalized.some((n) => rule.matches.test(n))) {
      for (const alias of rule.aliases) addOne(set, alias);
    }
  }

  set.delete("");
  return {
    accepted: [...set],
    franchiseKey:
      seriesSlug || stripMarkers(normalize(seriesName || athName)) || "?",
  };
}

/**
 * Augment an existing accepted-set with additional title strings (e.g.
 * AniList synonyms fetched after the opening was first pooled), running
 * them through the same alias pipeline so they pick up marker stripping
 * and acronym generation automatically. Also re-checks MANUAL_ALIASES
 * against the new names in case any of them triggers a curated rule
 * that wasn't satisfied by the original sources.
 *
 * Returns a NEW array; does not mutate the input.
 *
 * @param {string[]} acceptedArray  existing accepted entries
 * @param {string[]} extraNames     additional raw titles
 * @returns {string[]}
 */
export function extendAccepted(acceptedArray, extraNames) {
  if (!extraNames?.length) return acceptedArray || [];
  const set = new Set(acceptedArray || []);
  for (const name of extraNames) addName(set, name);
  const extraNormalized = extraNames.map(normalize);
  for (const rule of MANUAL_ALIASES) {
    if (extraNormalized.some((n) => rule.matches.test(n))) {
      for (const alias of rule.aliases) addOne(set, alias);
    }
  }
  set.delete("");
  return [...set];
}

export function isCorrect(guessText, acceptedArray) {
  if (!guessText || !acceptedArray?.length) return false;
  const set = new Set(acceptedArray);
  const g = normalize(guessText);
  // Also try the de-spaced form so separator-style acronyms ("A.o.T",
  // "S n K") collapse onto the stored acronym ("aot", "snk").
  const ga = stripArticle(g);
  const forms = [
    g,
    stripMarkers(g),
    g.replace(/ /g, ""),
    ga,
    stripMarkers(ga),
  ];
  if (forms.some((f) => f && f.length >= 2 && set.has(f))) return true;
  // Fallback: contiguous word-boundary substring of any accepted entry.
  // Catches the "famous partial name" pattern that exact-match misses
  // (Love is War inside "Kaguya-sama: Love is War — Ultra Romantic",
  // Bunny Girl Senpai inside the full Seishun Buta Yarou title, Madoka
  // Magica inside the full Puella Magi / Mahou Shoujo titles) without
  // having to hand-list each show. See isSubstringMatch for the safety
  // guards that stop "love" or "is war" from matching everything.
  return isSubstringMatch(g, acceptedArray);
}

// Tier 2 of guess matching: a guess is allowed if it appears as a
// CONTIGUOUS WORD-BOUNDARY SUBSTRING of any accepted title — but only
// when the guess is substantive enough to be unambiguous.
//
// Safety guards (all required):
//   - ≥ 2 words: single tokens go through the exact-match set only,
//     so "love" or "anime" can't substring-match into everything.
//   - ≥ 2 "substantive" (3+ char) words: filters fragments where the
//     content is all stopwords plus one keyword ("is war", "no game",
//     "the world"). The pair must carry enough identity on its own.
//   - ≥ 8 total chars: kills tiny phrases like "go go", "ai ga".
//   - Word-boundary padding (" guess " inside " name "): stops
//     "love is war" from matching "love is warrior" or partial-word
//     overlaps.
function isSubstringMatch(g, acceptedArray) {
  if (!g) return false;
  const words = g.split(" ").filter(Boolean);
  if (words.length < 2) return false;
  const substantive = words.filter((w) => w.length >= 3).length;
  if (substantive < 2) return false;
  if (g.length < 8) return false;
  const needle = " " + g + " ";
  return acceptedArray.some((name) => (" " + name + " ").includes(needle));
}
