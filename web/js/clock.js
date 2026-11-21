// Go clock state (fixed per-move or Japanese byo-yomi: main time + N periods of S seconds).
// Pure logic module so MatchRunner, UI, and Node unit tests share one source of truth.

export const CLOCK_MODES = ["fixed", "byoyomi"];

export function createClockConfig(cfg = {}) {
  const mode = cfg.clockMode === "byoyomi" ? "byoyomi" : "fixed";
  if (mode === "byoyomi") {
    const mainSec = Math.max(0, Number(cfg.mainTimeSec) || 0);
    const byoSec = Math.max(1, Number(cfg.byoyomiSec) || 30);
    const byoPeriods = Math.max(1, Math.round(Number(cfg.byoyomiPeriods) || 3));
    return { mode, mainSec, byoSec, byoPeriods };
  }
  return {
    mode: "fixed",
    timePerMove: Math.max(0, Number(cfg.timePerMove) || 0),
  };
}

export class GameClock {
  constructor(cfg = {}) {
    this.cfg = createClockConfig(cfg);
    this.sides = {
      B: this._initialSide(),
      W: this._initialSide(),
    };
  }

  _initialSide() {
    if (this.cfg.mode === "byoyomi") {
      return {
        mainMs: Math.round(this.cfg.mainSec * 1000),
        periods: this.cfg.byoPeriods,
        byoMs: Math.round(this.cfg.byoSec * 1000),
      };
    }
    return {
      mainMs: 0,
      periods: 0,
      byoMs: Math.round((this.cfg.timePerMove || 0) * 1000),
    };
  }

  get isByoyomi() {
    return this.cfg.mode === "byoyomi";
  }

  // Hard timeout in ms for the current move (0 = unlimited).
  moveLimitMs(color, graceMs = 0) {
    if (this.cfg.mode === "fixed") {
      return this.cfg.timePerMove > 0 ? this.cfg.timePerMove * 1000 + graceMs : 0;
    }
    const s = this.sides[color];
    if (!s) return 0;
    return s.mainMs + s.periods * s.byoMs + graceMs;
  }

  // GTP time_left / kgs-time_settings payload sent to engines before genmove.
  gtpState(color) {
    if (this.cfg.mode === "fixed") {
      return {
        mode: "fixed",
        timePerMove: this.cfg.timePerMove,
      };
    }
    const s = this.sides[color];
    const inMain = s.mainMs > 0;
    return {
      mode: "byoyomi",
      mainTime: Math.round(this.cfg.mainSec),
      byoTime: Math.round(this.cfg.byoSec),
      byoPeriods: this.cfg.byoPeriods,
      // GTP time_left <color> <seconds> <stones>:
      //   stones=0 when in main time; stones=periods (KGS style) or 1 when in byo-yomi.
      timeLeftSec: inMain ? Math.max(1, Math.ceil(s.mainMs / 1000)) : Math.max(1, Math.ceil(s.byoMs / 1000)),
      periodsLeft: inMain ? 0 : s.periods,
    };
  }

  // Deduct elapsed thinking time after a move completes. Returns { flag: boolean } (true = flagged on time).
  consume(color, elapsedMs, { enforce = true } = {}) {
    if (this.cfg.mode !== "byoyomi") {
      return { flag: false };
    }
    const s = this.sides[color];
    if (!s) return { flag: false };
    let rem = Math.max(0, elapsedMs);
    if (s.mainMs > 0) {
      if (rem <= s.mainMs) {
        s.mainMs -= rem;
        return { flag: false };
      }
      rem -= s.mainMs;
      s.mainMs = 0;
    }
    // Now in byo-yomi: if move took less than one period, periods count is preserved (Japanese byo-yomi).
    if (rem <= s.byoMs) {
      return { flag: false };
    }
    // Exceeded one period: each full byoMs burns one period.
    const burned = Math.floor(rem / s.byoMs);
    s.periods = Math.max(0, s.periods - burned);
    if (s.periods <= 0) {
      return { flag: enforce };
    }
    return { flag: false };
  }

  // Project live clock display for `color` assuming `elapsedMs` have passed on the current turn.
  display(color, elapsedMs = 0) {
    if (this.cfg.mode !== "byoyomi") {
      return null;
    }
    const s = this.sides[color];
    if (!s) return null;
    let mainMs = s.mainMs;
    let periods = s.periods;
    let curPeriodMs = s.byoMs;
    let rem = Math.max(0, elapsedMs);
    if (mainMs > 0) {
      if (rem <= mainMs) {
        mainMs -= rem;
        rem = 0;
      } else {
        rem -= mainMs;
        mainMs = 0;
      }
    }
    if (rem > 0) {
      const burned = Math.floor(rem / s.byoMs);
      periods = Math.max(0, periods - burned);
      if (periods > 0) {
        curPeriodMs = Math.max(0, s.byoMs - (rem % s.byoMs));
      } else {
        curPeriodMs = 0;
      }
    }
    const inByo = mainMs <= 0;
    const low = inByo && curPeriodMs <= 10000;
    return { mainMs, periods, curPeriodMs, inByo, low };
  }

  snapshot() {
    if (this.cfg.mode !== "byoyomi") return null;
    return {
      mode: "byoyomi",
      mainSec: this.cfg.mainSec,
      byoSec: this.cfg.byoSec,
      byoPeriods: this.cfg.byoPeriods,
      B: { ...this.sides.B },
      W: { ...this.sides.W },
    };
  }
}

export function formatClockMs(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Compute live display from a serialized clock snapshot (used on both host and guest).
export function projectClockSnapshot(snap, color, elapsedMs = 0) {
  if (!snap || snap.mode !== "byoyomi" || !snap[color]) return null;
  const clk = new GameClock({
    clockMode: "byoyomi",
    mainTimeSec: snap.mainSec,
    byoyomiSec: snap.byoSec,
    byoyomiPeriods: snap.byoPeriods,
  });
  clk.sides.B = { ...snap.B };
  clk.sides.W = { ...snap.W };
  return clk.display(color, elapsedMs);
}
