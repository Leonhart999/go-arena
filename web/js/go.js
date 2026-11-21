// Go rules for the referee: legality, captures, ko/superko, area scoring.
// Points are ints p = y * size + x, with y = 0 at the top (SGF order).

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
export const PASS = -1;
export const GTP_COLS = "ABCDEFGHJKLMNOPQRSTUVWXYZ"; // GTP skips the letter I
export const SGF_COLS = "abcdefghijklmnopqrstuvwxyz";
export const KO_RULES = ["simple", "positional", "situational"];
export const RULE_PRESETS = {
  chinese: { komi: 7.5, koRule: "positional", scoring: "area", sgfRule: "Chinese" },
  japanese: { komi: 6.5, koRule: "simple", scoring: "territory", sgfRule: "Japanese" },
};

// Standard star-point handicap placements (GTP coordinates) for 19x19, 13x13, and 9x9.
export function handicapVertices(size, count) {
  const n = Math.max(0, Math.min(9, Math.round(Number(count) || 0)));
  if (n < 2) return [];
  if (size !== 19 && size !== 13 && size !== 9) return [];
  const edge = size >= 13 ? 3 : 2;
  const far = size - 1 - edge;
  const mid = (size - 1) / 2;
  const gtp = (x, y) => `${GTP_COLS[x]}${size - y}`;
  // Standard order: top-right, bottom-left, bottom-right, top-left, center, left, right, top, bottom
  const tr = gtp(far, edge);
  const bl = gtp(edge, far);
  const br = gtp(far, far);
  const tl = gtp(edge, edge);
  const c = gtp(mid, mid);
  const ml = gtp(edge, mid);
  const mr = gtp(far, mid);
  const mt = gtp(mid, edge);
  const mb = gtp(mid, far);
  const table = {
    2: [tr, bl],
    3: [tr, bl, br],
    4: [tr, bl, br, tl],
    5: [tr, bl, br, tl, c],
    6: [tr, bl, br, tl, ml, mr],
    7: [tr, bl, br, tl, ml, mr, c],
    8: [tr, bl, br, tl, ml, mr, mt, mb],
    9: [tr, bl, br, tl, ml, mr, mt, mb, c],
  };
  return table[n] || [];
}

export const other = (color) => BLACK + WHITE - color;
export const colorLetter = (color) => (color === BLACK ? "B" : "W");

export function colorFromLetter(text) {
  const t = String(text).trim().toUpperCase();
  if (t === "B" || t === "BLACK") return BLACK;
  if (t === "W" || t === "WHITE") return WHITE;
  throw new Error(`bad color ${text}`);
}

export class IllegalMove extends Error {
  constructor(message) {
    super(message);
    this.name = "IllegalMove";
  }
}

const neighbourCache = new Map();

function neighbours(size) {
  if (!neighbourCache.has(size)) {
    const list = [];
    for (let p = 0; p < size * size; p++) {
      const x = p % size;
      const y = (p - x) / size;
      const nb = [];
      if (y > 0) nb.push(p - size);
      if (y < size - 1) nb.push(p + size);
      if (x > 0) nb.push(p - 1);
      if (x < size - 1) nb.push(p + 1);
      list.push(nb);
    }
    neighbourCache.set(size, list);
  }
  return neighbourCache.get(size);
}

export class Board {
  constructor(size = 19, koRule = "positional") {
    if (!Number.isInteger(size) || size < 2 || size > 25) throw new Error(`unsupported board size ${size}`);
    if (!KO_RULES.includes(koRule)) throw new Error(`unknown ko rule ${koRule}`);
    this.size = size;
    this.koRule = koRule;
    this.stones = new Uint8Array(size * size);
    this.koPoint = -1;
    this.captures = { [BLACK]: 0, [WHITE]: 0 };
    this.nbrs = neighbours(size);
    this.history = new Set([this.key(BLACK)]);
  }

  clone() {
    const b = Object.create(Board.prototype);
    b.size = this.size;
    b.koRule = this.koRule;
    b.stones = this.stones.slice();
    b.koPoint = this.koPoint;
    b.captures = { ...this.captures };
    b.nbrs = this.nbrs;
    b.history = new Set(this.history);
    return b;
  }

  // Position key for superko. Situational superko also keys on the side to move.
  key(toMove) {
    const k = this.stones.join("");
    return this.koRule === "situational" ? k + toMove : k;
  }

  // ---- coordinates --------------------------------------------------------
  fromGtp(vertex) {
    const v = String(vertex).trim().toUpperCase();
    if (v === "PASS") return PASS;
    const x = GTP_COLS.indexOf(v[0]);
    const row = Number(v.slice(1));
    if (x < 0 || !/^\d{1,2}$/.test(v.slice(1))) throw new IllegalMove(`bad vertex ${vertex}`);
    const y = this.size - row;
    if (x >= this.size || y < 0 || y >= this.size) throw new IllegalMove(`vertex ${vertex} is off the board`);
    return y * this.size + x;
  }

  toGtp(point) {
    if (point === PASS) return "pass";
    const x = point % this.size;
    const y = (point - x) / this.size;
    return `${GTP_COLS[x]}${this.size - y}`;
  }

  toSgf(point) {
    if (point === PASS) return "";
    const x = point % this.size;
    const y = (point - x) / this.size;
    return SGF_COLS[x] + SGF_COLS[y];
  }

  // ---- rules --------------------------------------------------------------
  // Returns the chain containing start and whether it has a liberty.
  group(start) {
    const color = this.stones[start];
    const seen = new Set([start]);
    const stack = [start];
    let hasLiberty = false;
    while (stack.length) {
      const p = stack.pop();
      for (const q of this.nbrs[p]) {
        const s = this.stones[q];
        if (s === EMPTY) hasLiberty = true;
        else if (s === color && !seen.has(q)) {
          seen.add(q);
          stack.push(q);
        }
      }
    }
    return { chain: [...seen], hasLiberty };
  }

  // Plays a move and returns the number of captured stones. Throws IllegalMove.
  play(color, point) {
    if (point === PASS) {
      this.koPoint = -1;
      return 0;
    }
    if (this.stones[point] !== EMPTY) throw new IllegalMove(`${this.toGtp(point)} is occupied`);
    if (point === this.koPoint) throw new IllegalMove(`${this.toGtp(point)} retakes a ko`);

    const opp = other(color);
    this.stones[point] = color;
    const captured = [];
    for (const q of this.nbrs[point]) {
      if (this.stones[q] !== opp) continue;
      const { chain, hasLiberty } = this.group(q);
      if (hasLiberty) continue;
      for (const s of chain) {
        if (this.stones[s] === opp) {
          this.stones[s] = EMPTY;
          captured.push(s);
        }
      }
    }
    if (!this.group(point).hasLiberty) {
      this.stones[point] = EMPTY;
      throw new IllegalMove(`${this.toGtp(point)} is suicide`);
    }

    if (this.koRule !== "simple") {
      const key = this.key(opp);
      if (this.history.has(key)) {
        for (const s of captured) this.stones[s] = opp;
        this.stones[point] = EMPTY;
        throw new IllegalMove(`${this.toGtp(point)} repeats a position (${this.koRule} superko)`);
      }
      this.history.add(key);
    }

    // Simple ko: one stone captured one stone and is itself left in atari.
    this.koPoint = -1;
    if (captured.length === 1) {
      const { chain } = this.group(point);
      const libs = this.nbrs[point].filter((q) => this.stones[q] === EMPTY);
      if (chain.length === 1 && libs.length === 1) this.koPoint = captured[0];
    }
    this.captures[color] += captured.length;
    return captured.length;
  }

  isLegal(color, point) {
    try {
      this.clone().play(color, point);
      return true;
    } catch (e) {
      if (e instanceof IllegalMove) return false;
      throw e;
    }
  }

  // Tromp-Taylor area count (no komi). Stones in deadSet (optional Set/Array of
  // point indices) are treated as removed/empty before counting territory.
  areaScore(deadSet = null) {
    const n = this.stones.length;
    const dead = deadSet ? (deadSet instanceof Set ? deadSet : new Set(deadSet)) : null;
    const owner = new Uint8Array(n);
    const seen = new Uint8Array(n);
    const eff = (p) => (dead && dead.has(p) ? EMPTY : this.stones[p]);
    let black = 0;
    let white = 0;
    for (let i = 0; i < n; i++) {
      const s = eff(i);
      if (s !== EMPTY) {
        owner[i] = s;
        if (s === BLACK) black++;
        else white++;
        continue;
      }
      if (seen[i]) continue;
      const region = [];
      let borders = 0; // bit 1 = black, bit 2 = white
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const p = stack.pop();
        region.push(p);
        for (const q of this.nbrs[p]) {
          const t = eff(q);
          if (t === EMPTY) {
            if (!seen[q]) {
              seen[q] = 1;
              stack.push(q);
            }
          } else borders |= t;
        }
      }
      if (borders === BLACK || borders === WHITE) {
        for (const p of region) owner[p] = borders;
        if (borders === BLACK) black += region.length;
        else white += region.length;
      }
    }
    return { black, white, owner };
  }

  // Japanese-style territory count (no komi): empty enclosed points + captures + dead stones removed.
  // Note: captures[BLACK] counts White stones captured by Black. Dead White stones add to Black's
  // prisoners and their intersections become empty territory; dead Black stones add to White's.
  territoryScore(deadSet = null) {
    const n = this.stones.length;
    const dead = deadSet ? (deadSet instanceof Set ? deadSet : new Set(deadSet)) : null;
    const owner = new Uint8Array(n);
    const seen = new Uint8Array(n);
    let deadBlack = 0;
    let deadWhite = 0;
    if (dead) {
      for (const p of dead) {
        if (this.stones[p] === BLACK) deadBlack++;
        else if (this.stones[p] === WHITE) deadWhite++;
      }
    }
    const eff = (p) => (dead && dead.has(p) ? EMPTY : this.stones[p]);
    let blackTerr = 0;
    let whiteTerr = 0;
    for (let i = 0; i < n; i++) {
      const s = eff(i);
      if (s !== EMPTY) {
        owner[i] = s;
        continue;
      }
      if (seen[i]) continue;
      const region = [];
      let borders = 0;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const p = stack.pop();
        region.push(p);
        for (const q of this.nbrs[p]) {
          const t = eff(q);
          if (t === EMPTY) {
            if (!seen[q]) {
              seen[q] = 1;
              stack.push(q);
            }
          } else borders |= t;
        }
      }
      if (borders === BLACK || borders === WHITE) {
        for (const p of region) owner[p] = borders;
        if (borders === BLACK) blackTerr += region.length;
        else whiteTerr += region.length;
      }
    }
    const black = blackTerr + this.captures[BLACK] + deadWhite;
    const white = whiteTerr + this.captures[WHITE] + deadBlack;
    return { black, white, blackTerr, whiteTerr, owner };
  }
}

// One game in progress: board plus move list, with strict color alternation.
export class GameState {
  constructor(size, komi, koRule = "positional", initialMoves = null) {
    this.size = size;
    this.komi = komi;
    this.koRule = koRule;
    this.board = new Board(size, koRule);
    this.moves = []; // [colorLetter, gtpVertex, thinkMs]
    this.toPlay = BLACK;
    this.consecutivePasses = 0;
    this.lastPoint = null;
    if (Array.isArray(initialMoves) && initialMoves.length) {
      for (const [c, v, ms] of initialMoves) this.apply(colorFromLetter(c), v, ms ?? 0);
    }
  }

  static fromMoves(size, komi, koRule, moves) {
    return new GameState(size, komi, koRule, moves);
  }

  // Apply a move; when allowSameColor is true, permits non-alternating sequences
  // (e.g., SGF setup stones converted into moves).
  apply(color, vertex, ms = 0, { allowSameColor = false } = {}) {
    if (!allowSameColor && color !== this.toPlay) throw new IllegalMove(`it is ${colorLetter(this.toPlay)}'s turn`);
    const point = this.board.fromGtp(vertex);
    this.board.play(color, point);
    this.moves.push([colorLetter(color), this.board.toGtp(point), Math.round(ms)]);
    this.consecutivePasses = point === PASS ? this.consecutivePasses + 1 : 0;
    this.toPlay = other(color);
    this.lastPoint = point;
    return point;
  }

  // Black minus white by Tromp-Taylor area count, komi included.
  trompTaylor(deadSet = null) {
    const { black, white, owner } = this.board.areaScore(deadSet);
    return { black, white, owner, diff: black - white - this.komi };
  }

  // Black minus white by Japanese territory count, komi included.
  japaneseScore(deadSet = null) {
    const { black, white, owner } = this.board.territoryScore(deadSet);
    return { black, white, owner, diff: black - white - this.komi };
  }
}

export function formatScore(diff) {
  if (diff === 0) return "0";
  return diff > 0 ? `B+${diff}` : `W+${-diff}`;
}
