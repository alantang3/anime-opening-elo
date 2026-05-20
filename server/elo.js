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

// Wins are worth more than losses cost (non-zero-sum), but the gap is
// modest — at 0.8 the loser drops most of what the winner gained, so
// ranking up still takes net positive play and isn't a one-way ratchet.
const LOSS_MULT = 0.8;

// Even when paired with someone far below you, you should not gain ZERO
// Elo for a win — the queue is FIFO, you didn't choose the matchup. Floor
// the winner's pre-rounding delta here so a +800 Elo gap still yields a
// small but real reward.
const MIN_WIN_DELTA = 5;

// Same idea on the other side: forfeiting (or losing) against a higher-Elo
// opponent must still cost you SOMETHING — you can't escape the round
// scot-free just because the opponent outranks you.
const MIN_LOSS_DELTA = 2;

// A win by opponent FORFEIT (voluntary leave OR disconnect) is worth this
// fraction of a guessed win: you didn't actually name the opening, so the
// reward (and the loser's proportional loss) is scaled down. Applied AFTER
// the MIN_WIN_DELTA floor so a forfeit-win is strictly ≤ a guessed win at
// every matchup.
const FORFEIT_MULT = 0.5;

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
 * Resolve a decided round (someone guessed correctly, or a forfeit).
 * NON-zero-sum on purpose: the winner gains the delta, the loser drops
 * LOSS_MULT of it (then clamped to the Elo floor).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.forfeit] true if the win came from the opponent
 *   leaving / disconnecting (not from a correct guess) — scales the delta
 *   down by FORFEIT_MULT.
 * @param {boolean} [opts.voluntary] true if the loser hit the Forfeit
 *   button (a SUBSET of forfeit). Voluntary forfeits give the winner ZERO
 *   Elo — otherwise the meta becomes baiting low-attention opponents into
 *   leaving so you can farm their Elo. The forfeiter still loses normally
 *   (so quitting isn't a way to dodge the loss).
 */
export function resolveWin(winnerElo, loserElo, popFactor, opts = {}) {
  const { forfeit = false, voluntary = false } = opts;
  const k = effectiveK(popFactor);
  const expWin = expectedScore(winnerElo, loserElo);
  let delta = Math.max(MIN_WIN_DELTA, k * (1 - expWin));
  if (forfeit) delta *= FORFEIT_MULT;

  // Whole-number ratings: round the resulting Elo, then derive the deltas
  // from the rounded values so what's shown ("+27") always equals the actual
  // change in the displayed rating.
  const loserLoss = Math.max(MIN_LOSS_DELTA, delta * LOSS_MULT);
  // Voluntary forfeit short-circuits the winner's gain to 0 — no farming
  // by waiting people out. Loser's loss is untouched.
  const winnerGain = voluntary ? 0 : delta;
  const winnerAfter = Math.round(winnerElo + winnerGain);
  const loserAfter = Math.round(floor(loserElo - loserLoss));

  return {
    kEff: round1(k),
    expectedWinner: Math.round(expWin * 100), // %
    winnerDelta: Math.round(winnerAfter - winnerElo),
    loserDelta: Math.round(loserAfter - loserElo),
    winnerAfter,
    loserAfter,
  };
}

/**
 * Resolve a timed-out round: nobody got it before the opening ended, so both
 * players take the flat penalty (recorded as a draw each in the DB).
 */
export function resolveTimeout(aElo, bElo) {
  const aAfter = Math.round(floor(aElo - TIMEOUT_PENALTY));
  const bAfter = Math.round(floor(bElo - TIMEOUT_PENALTY));
  return {
    aDelta: Math.round(aAfter - aElo),
    bDelta: Math.round(bAfter - bElo),
    aAfter,
    bAfter,
  };
}
