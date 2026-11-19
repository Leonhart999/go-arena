// Match statistics for seat A against seat B. Draws count as half a win.

const Z95 = 1.959964;

function erf(x) {
  // Abramowitz-Stegun 7.1.26, max error 1.5e-7.
  const sign = Math.sign(x);
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

// Wilson score interval for a proportion p over n trials.
export function wilson(p, n, z = Z95) {
  if (n === 0) return [0, 1];
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function eloFromScore(s) {
  if (s <= 0) return -Infinity;
  if (s >= 1) return Infinity;
  return -400 * Math.log10(1 / s - 1) || 0;
}

// Likelihood of superiority of A over B, from decisive games only.
export function los(wins, losses) {
  if (wins + losses === 0) return 0.5;
  return 0.5 * (1 + erf((wins - losses) / Math.sqrt(2 * (wins + losses))));
}

export function summarize(records) {
  const s = {
    games: 0, voids: 0, aWins: 0, bWins: 0, draws: 0,
    blackWins: 0, whiteWins: 0,
    aAsBlack: { w: 0, l: 0, d: 0 }, aAsWhite: { w: 0, l: 0, d: 0 },
    thinkMs: { A: 0, B: 0 }, moveCount: { A: 0, B: 0 }, totalMoves: 0,
  };
  for (const r of records) {
    if (r.void) {
      s.voids++;
      continue;
    }
    s.games++;
    s.totalMoves += r.moves.length;
    for (const seat of ["A", "B"]) {
      s.thinkMs[seat] += r.thinkMs?.[seat] ?? 0;
      s.moveCount[seat] += r.moveCount?.[seat] ?? 0;
    }
    const aColor = r.blackSeat === "A" ? s.aAsBlack : s.aAsWhite;
    if (r.winnerSeat === null) {
      s.draws++;
      aColor.d++;
      continue;
    }
    if (r.winnerSeat === "A") {
      s.aWins++;
      aColor.w++;
    } else {
      s.bWins++;
      aColor.l++;
    }
    if (r.winnerSeat === r.blackSeat) s.blackWins++;
    else s.whiteWins++;
  }
  const n = s.games;
  s.score = n ? (s.aWins + 0.5 * s.draws) / n : 0.5;
  s.ci = wilson(s.score, n);
  s.elo = eloFromScore(s.score);
  s.eloCi = s.ci.map(eloFromScore);
  s.los = los(s.aWins, s.bWins);
  s.avgMs = {
    A: s.moveCount.A ? s.thinkMs.A / s.moveCount.A : 0,
    B: s.moveCount.B ? s.thinkMs.B / s.moveCount.B : 0,
  };
  s.avgLength = n ? s.totalMoves / n : 0;
  return s;
}

export function formatElo(x) {
  if (x === Infinity) return "+inf";
  if (x === -Infinity) return "-inf";
  return (x >= 0 ? "+" : "") + Math.round(x);
}
