// Host-side match referee: asks seated players for moves, enforces the
// rules and the move clock, scores finished games and keeps the records.
import { BLACK, GameState, IllegalMove, colorFromLetter, colorLetter, formatScore } from "./go.js";
import { Cancelled, Disconnected } from "./players.js";

// Extra time allowed on top of the per-move limit for process and network lag.
export const GRACE_MS = 3000;

export const DEFAULT_CONFIG = {
  size: 19,
  komi: 7.5,
  koRule: "positional",
  games: 10,
  alternate: true,
  timePerMove: 10, // seconds, 0 = unlimited
  maxMoves: 0, // 0 = 2 * size * size
  moveDelay: 0, // ms pause after each move, for watching
  initialMoves: null, // optional [[color, vertex], ...] prefix for game 1 (resume from review)
  startBlackSeat: null, // optional "A" | "B" for game 1
};

class Timeout extends Error {}

class StopGame extends Error {
  constructor(reason) {
    super(reason);
    this.name = "StopGame";
  }
}

class UndoSignal extends Error {
  constructor(steps) {
    super("undo");
    this.name = "UndoSignal";
    this.steps = steps;
  }
}

const otherSeat = (seat) => (seat === "A" ? "B" : "A");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms) {
  if (!ms) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Timeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// "B+3.5" -> 3.5, "W+R" -> null, "0" -> 0
export function parseScore(text) {
  const t = String(text ?? "").trim().toUpperCase();
  if (t === "0" || t === "JIGO" || t === "DRAW") return 0;
  const m = /^([BW])\+(\d+(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  return (m[1] === "B" ? 1 : -1) * Number(m[2]);
}

export class MatchRunner extends EventTarget {
  constructor(config, seats, { referee = null, scoreConfirm = null } = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.seats = { ...seats }; // { A: player, B: player }
    this.referee = referee; // EnginePlayer used only for final_score, or null
    this.scoreConfirm = scoreConfirm; // optional async (game) => Set<point> | null (null = resume playing)
    this.records = [];
    this.current = null;
    this.running = false;
    this.paused = false;
    this.stopped = false;
    this.voidReason = null;
    this._interrupt = null;
    this._resumers = [];
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  log(text) {
    this.emit("log", text);
  }

  // ---- controls -----------------------------------------------------------
  setSeat(seat, player) {
    this.seats[seat] = player;
  }

  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.emit("state");
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    const r = this._resumers;
    this._resumers = [];
    r.forEach((f) => f());
    this.emit("state");
  }

  stop() {
    if (!this.running) return;
    this.stopped = true;
    this._interrupt?.(new StopGame("match stopped"));
    this.resume();
    this.emit("state");
  }

  // Abandon the game in progress; it is recorded as void and replayed.
  voidCurrent(reason) {
    if (!this.current || this.current.result) return;
    this.voidReason = reason;
    this._interrupt?.(new StopGame(reason));
  }

  // Undo the last `steps` plies in the current game (used during local human games).
  requestUndo(steps = 1) {
    if (!this.current || this.current.result || !this._interrupt) return false;
    const minLen = this.current.initialCount || 0;
    const avail = this.current.game.moves.length - minLen;
    if (avail <= 0) return false;
    const count = Math.min(avail, Math.max(1, steps));
    this._interrupt(new UndoSignal(count));
    return true;
  }

  _interruptible(promise) {
    return new Promise((resolve, reject) => {
      this._interrupt = reject;
      promise.then(resolve, reject);
    }).finally(() => {
      this._interrupt = null;
    });
  }

  async _waitWhilePaused() {
    while (this.paused && !this.stopped) {
      await this._interruptible(new Promise((r) => this._resumers.push(r)));
    }
  }

  // ---- match --------------------------------------------------------------
  async run() {
    this.running = true;
    this.emit("state");
    let played = 0;
    try {
      while (played < this.config.games && !this.stopped) {
        try {
          await this._waitWhilePaused();
        } catch (e) {
          if (!(e instanceof StopGame)) throw e;
          this.voidReason = null;
        }
        if (this.stopped) break;
        const firstBlack = this.config.startBlackSeat === "B" ? "B" : "A";
        const blackSeat = this.config.alternate && played % 2 === 1 ? otherSeat(firstBlack) : firstBlack;
        const prefix = played === 0 && Array.isArray(this.config.initialMoves) && this.config.initialMoves.length
          ? this.config.initialMoves
          : null;
        const rec = await this.playGame(this.records.length, blackSeat, prefix);
        this.records.push(rec);
        this.emit("record", rec);
        if (!rec.void) played++;
        else if (!this.stopped) {
          // Something went away (bridge, guest). Wait for the host to fix it;
          // the same game number is replayed on resume.
          this.paused = true;
          this.log("Match paused after a void game. Fix the cause, then press Resume.");
          this.emit("state");
        }
      }
    } finally {
      this.running = false;
      this.paused = false;
      this.emit("state");
      this.emit("done");
    }
  }

  async playGame(index, blackSeat, initialMoves = null) {
    const cfg = this.config;
    const whiteSeat = otherSeat(blackSeat);
    const colorOf = (seat) => (seat === blackSeat ? "B" : "W");
    const buildGame = (moveList) => {
      const state = new GameState(cfg.size, cfg.komi, cfg.koRule);
      if (Array.isArray(moveList)) {
        for (const [c, v, ms] of moveList) {
          state.apply(colorFromLetter(c), v, ms ?? 0, { allowSameColor: true });
        }
      }
      return state;
    };
    let g = buildGame(initialMoves);
    const initialCount = g.moves.length;
    const labels = { A: this.seats.A.label, B: this.seats.B.label };
    const maxMoves = cfg.maxMoves > 0 ? cfg.maxMoves : 2 * cfg.size * cfg.size;
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const thinkMs = { A: 0, B: 0 };
    const moveCount = { A: 0, B: 0 };
    const cur = (this.current = { index, blackSeat, labels, game: g, initialCount, result: null, reason: "", owner: null, thinking: null });
    this.voidReason = null;
    this.log(
      initialCount
        ? `Game ${index + 1}: ${labels[blackSeat]} (B) vs ${labels[whiteSeat]} (W) (resumed from move ${initialCount})`
        : `Game ${index + 1}: ${labels[blackSeat]} (B) vs ${labels[whiteSeat]} (W)`,
    );
    this.emit("state");

    const win = (seat, how, reason) => ({ winnerSeat: seat, result: `${colorOf(seat)}+${how}`, reason });
    const lose = (seat, how, reason) => win(otherSeat(seat), how, reason);
    const fromDiff = (diff, reason) => ({
      winnerSeat: diff === 0 ? null : diff > 0 ? blackSeat : whiteSeat,
      result: formatScore(diff),
      reason,
    });

    let end = null;
    try {
      while (!end) {
        await this._waitWhilePaused();
        if (this.stopped) throw new StopGame("match stopped");
        if (this.voidReason) throw new StopGame(this.voidReason);

        const color = g.toPlay;
        const seat = color === BLACK ? blackSeat : whiteSeat;
        const player = this.seats[seat];
        const ctx = {
          size: cfg.size,
          komi: cfg.komi,
          koRule: cfg.koRule,
          color: colorLetter(color),
          moves: g.moves.map(([c, v]) => [c, v]),
          timePerMove: cfg.timePerMove,
        };
        const limitMs = player.kind !== "human" && cfg.timePerMove > 0 ? cfg.timePerMove * 1000 + GRACE_MS : 0;
        cur.thinking = { seat, color: ctx.color, since: Date.now() };
        this.emit("state");

        const start = performance.now();
        let move;
        try {
          move = await this._interruptible(withTimeout(player.requestMove(ctx), limitMs));
        } catch (e) {
          cur.thinking = null;
          player.cancel();
          if (e instanceof UndoSignal) {
            const trimmed = g.moves.slice(0, Math.max(initialCount, g.moves.length - e.steps));
            g = buildGame(trimmed);
            cur.game = g;
            cur.owner = null;
            this.log(`Undid ${e.steps} move(s) (now at move ${g.moves.length})`);
            this.emit("state");
            continue;
          }
          if (e instanceof StopGame) throw e;
          if (e instanceof Disconnected || e instanceof Cancelled) throw new StopGame(e.message);
          if (e instanceof Timeout) end = lose(seat, "T", `${labels[seat]} exceeded ${cfg.timePerMove}s per move`);
          else end = lose(seat, "F", `${labels[seat]} failed: ${e.message}`);
          break;
        }
        const ms = performance.now() - start;
        cur.thinking = null;
        thinkMs[seat] += ms;
        moveCount[seat]++;

        const mv = String(move ?? "").trim();
        if (mv.toLowerCase() === "resign") {
          end = lose(seat, "R", `${labels[seat]} resigned`);
          break;
        }
        let captured = 0;
        try {
          const prevCap = g.board.captures[color];
          g.apply(color, mv, ms);
          captured = g.board.captures[color] - prevCap;
        } catch (e) {
          if (!(e instanceof IllegalMove)) throw e;
          end = lose(seat, "F", `illegal move "${mv}" by ${labels[seat]}: ${e.message}`);
          break;
        }
        this.emit("move", { color: ctx.color, move: mv, moveNo: g.moves.length, captured });

        if (g.consecutivePasses >= 2) {
          const hasHuman = this.seats.A.kind === "human" || this.seats.B.kind === "human";
          if (!this.referee && hasHuman && typeof this.scoreConfirm === "function") {
            const deadSet = await this._interruptible(this.scoreConfirm(g));
            if (deadSet === null) {
              // Players chose to resume playing instead of scoring
              g.consecutivePasses = 0;
              this.emit("state");
              continue;
            }
            const tt = g.trompTaylor(deadSet);
            this.current.owner = tt.owner;
            const deadSuffix = deadSet && deadSet.size ? `, ${deadSet.size} dead marked` : "";
            end = fromDiff(tt.diff, `both passed; area B ${tt.black} W ${tt.white} komi ${g.komi}${deadSuffix}`);
          } else {
            end = await this.score(g, "both passed", fromDiff);
          }
        } else if (g.moves.length >= maxMoves) {
          end = await this.score(g, `move limit ${maxMoves}`, fromDiff);
        } else if (cfg.moveDelay > 0) {
          await this._interruptible(sleep(cfg.moveDelay));
        }
      }
    } catch (e) {
      if (!(e instanceof StopGame)) throw e;
      end = { void: true, result: "Void", reason: e.message };
    }
    cur.thinking = null;

    const rec = {
      index,
      blackSeat,
      labels,
      size: cfg.size,
      komi: cfg.komi,
      koRule: cfg.koRule,
      moves: g.moves,
      result: end.result,
      winnerSeat: end.void ? undefined : end.winnerSeat,
      void: !!end.void,
      reason: end.reason,
      startedAt,
      durationMs: Math.round(performance.now() - t0),
      thinkMs: { A: Math.round(thinkMs.A), B: Math.round(thinkMs.B) },
      moveCount,
    };
    cur.result = rec.result;
    cur.reason = rec.reason;
    this.log(`Game ${index + 1}: ${rec.result} (${rec.reason})`);
    this.emit("state");
    return rec;
  }

  async score(g, why, fromDiff) {
    if (this.referee) {
      try {
        const text = await this._interruptible(this.referee.finalScore({ size: g.size, komi: g.komi, moves: g.moves }));
        const diff = parseScore(text);
        if (diff !== null) return fromDiff(diff, `${why}; referee engine scored ${text}`);
        this.log(`Referee returned "${text}", falling back to Tromp-Taylor`);
      } catch (e) {
        if (e instanceof StopGame) throw e;
        this.log(`Referee failed (${e.message}), falling back to Tromp-Taylor`);
      }
    }
    const tt = g.trompTaylor();
    this.current.owner = tt.owner;
    return fromDiff(tt.diff, `${why}; Tromp-Taylor B ${tt.black} W ${tt.white} komi ${g.komi}`);
  }

  // Serializable view of the match for rendering and for room guests.
  snapshot() {
    const c = this.current;
    return {
      running: this.running,
      paused: this.paused,
      config: this.config,
      seats: { A: this.seats.A.label, B: this.seats.B.label },
      current: c && {
        index: c.index,
        blackSeat: c.blackSeat,
        labels: c.labels,
        size: c.game.size,
        komi: c.game.komi,
        koRule: c.game.koRule,
        moves: c.game.moves,
        captures: { B: c.game.board.captures[1], W: c.game.board.captures[2] },
        result: c.result,
        reason: c.reason,
        owner: c.owner ? Array.from(c.owner) : null,
        thinking: c.thinking && { seat: c.thinking.seat, color: c.thinking.color, elapsed: Date.now() - c.thinking.since },
      },
    };
  }
}
