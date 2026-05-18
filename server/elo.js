// PvP Elo with a popularity-scaled K-factor.
//
// `popFactor` ∈ [0,1] comes from popularity.js: ~1 = obscure show (big Elo
// swing — naming it is impressive), ~0 = mega-popular show (small swing).
// Effective K = K_BASE · (K_FLOOR_MULT + popFactor), so an obscure win is
// worth ~3x an equally-expected win on a blockbuster.
//
// All constants are gathered here so the game can be retuned in one place.

import { ELO_FLOOR } from "./db.js";

// Big, satisfying numbers: an even-match win on a mainstream show is ~+28,
// a moderate one ~+45, and an obscure or upset win can be +70 to +130. The
// wide swings also spread ratings across a much larger range over time.
export const K_BASE = 100;
const K_FLOOR_MULT = 0.5; // even popular wins move Elo a lot

// Wins are worth more than losses cost: correctly naming an OP is hard, so a
// good guess should feel rewarding while a miss shouldn't gut your rating.
// The loser drops only this fraction of the winner's gain — deliberately
// NON-zero-sum (net Elo inflates over time, which also keeps the difficulty
// ramp gentle).
const LOSS_MULT = 0.5;

// Timeout (nobody guessed before the song ended): both players lose a flat,
// popularity-independent penalty. Kept flat on purpose — scaling it by
// popularity creates perverse incentives either direction, and the product
// rule is simply "you both lose points".
export const TIMEOUT_PENALTY = 20;

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
 * NON-zero-sum on purpose: the winner gains the full Elo delta, the loser
 * drops only LOSS_MULT of it (then clamped to the Elo floor).
 */
export function resolveWin(winnerElo, loserElo, popFactor) {
  const k = effectiveK(popFactor);
  const expWin = expectedScore(winnerElo, loserElo);
  const delta = k * (1 - expWin);

  const winnerAfter = winnerElo + delta;
  const loserAfter = floor(loserElo - delta * LOSS_MULT);

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
