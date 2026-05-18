// PvP Elo with a popularity-scaled K-factor.
//
// `popFactor` ∈ [0,1] comes from popularity.js: ~1 = obscure show (big Elo
// swing — naming it is impressive), ~0 = mega-popular show (small swing).
// Effective K = K_BASE · (K_FLOOR_MULT + popFactor), so an obscure win is
// worth ~3x an equally-expected win on a blockbuster.
//
// All constants are gathered here so the game can be retuned in one place.

import { ELO_FLOOR } from "./db.js";

export const K_BASE = 32;
const K_FLOOR_MULT = 0.4; // popular shows still move Elo a little

// Timeout (nobody guessed before the song ended): both players lose a flat,
// popularity-independent penalty. Kept flat on purpose — scaling it by
// popularity creates perverse incentives either direction, and the product
// rule is simply "you both lose points".
export const TIMEOUT_PENALTY = 12;

const round1 = (x) => Math.round(x * 10) / 10;
const floor = (elo) => Math.max(ELO_FLOOR, elo);

export function expectedScore(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

export function effectiveK(popFactor) {
  const f = Number.isFinite(popFactor) ? popFactor : 0.5;
  return K_BASE * (K_FLOOR_MULT + f);
}

/**
 * Resolve a decided round (someone guessed correctly, or a disconnect forfeit).
 * Zero-sum: the winner gains exactly what the loser drops, then the loser is
 * clamped to the Elo floor (the winner keeps their full gain).
 */
export function resolveWin(winnerElo, loserElo, popFactor) {
  const k = effectiveK(popFactor);
  const expWin = expectedScore(winnerElo, loserElo);
  const delta = k * (1 - expWin);

  const winnerAfter = winnerElo + delta;
  const loserAfter = floor(loserElo - delta);

  return {
    kEff: round1(k),
    expectedWinner: Math.round(expWin * 100), // %
    winnerDelta: round1(winnerAfter - winnerElo),
    loserDelta: round1(loserAfter - loserElo),
    winnerAfter,
    loserAfter,
  };
}

/**
 * Resolve a timed-out round: nobody got it before the opening ended, so both
 * players take the flat penalty (recorded as a draw each in the DB).
 */
export function resolveTimeout(aElo, bElo) {
  const aAfter = floor(aElo - TIMEOUT_PENALTY);
  const bAfter = floor(bElo - TIMEOUT_PENALTY);
  return {
    aDelta: round1(aAfter - aElo),
    bDelta: round1(bAfter - bElo),
    aAfter,
    bAfter,
  };
}
