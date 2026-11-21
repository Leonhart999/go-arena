// Analysis scheduler, normalization, blunder detection, and per-game evaluation cache.
// All winrate / scoreLead / ownership values are stored from Black's perspective:
//   winrate:   0..1 (Black win probability)
//   scoreLead: number | null (> 0 means Black leads in points)
//   ownership: number[] | null (size*size, +1 Black, -1 White)

export const DEFAULT_ANALYSIS_OPTIONS = {
  maxTimeMs: 450,
  maxVisits: 0,
  maxMoves: 5,
  includeOwnership: true,
};

// Strip bulky ownership array before persisting into game records / localStorage.
export function stripForRecord(entry) {
  if (!entry) return null;
  const slim = {
    moveNo: entry.moveNo,
    winrate: entry.winrate,
    scoreLead: entry.scoreLead ?? null,
    visits: entry.visits ?? 0,
  };
  if (Array.isArray(entry.moves) && entry.moves.length) {
    slim.moves = entry.moves.slice(0, 5).map((m) => ({
      move: m.move,
      visits: m.visits ?? 0,
      winrate: m.winrate,
      scoreLead: m.scoreLead ?? null,
      pv: Array.isArray(m.pv) ? m.pv.slice(0, 12) : [],
    }));
  }
  return slim;
}

// Identify significant blunders / turning points in a chronological analysis series.
// series: sparse array or list of { moveNo, winrate, scoreLead } indexed by moveNo (0..N).
// A move k (1..N) was played by Black if k is odd (assuming standard alternation), or by moves[k-1][0].
export function detectBlunders(series, moves = [], { wrDrop = 0.1, scoreDrop = 3.5 } = {}) {
  const map = new Map();
  if (Array.isArray(series)) {
    for (const item of series) {
      if (item && Number.isInteger(item.moveNo) && typeof item.winrate === "number") {
        map.set(item.moveNo, item);
      }
    }
  }
  const ordered = [...map.keys()].sort((a, b) => a - b);
  const blunders = [];
  for (let i = 1; i < ordered.length; i++) {
    const prevNo = ordered[i - 1];
    const curNo = ordered[i];
    if (curNo !== prevNo + 1) continue; // only score consecutive analyzed plies
    const prev = map.get(prevNo);
    const cur = map.get(curNo);
    const mover = moves[curNo - 1]?.[0] ?? (curNo % 2 === 1 ? "B" : "W");
    const isBlack = String(mover).toUpperCase() === "B";

    // Positive drop means the player who just moved lost winrate / points.
    const dWr = isBlack ? prev.winrate - cur.winrate : cur.winrate - prev.winrate;
    const hasScore = typeof prev.scoreLead === "number" && typeof cur.scoreLead === "number";
    const dScore = hasScore ? (isBlack ? prev.scoreLead - cur.scoreLead : cur.scoreLead - prev.scoreLead) : 0;

    if (dWr >= wrDrop || (hasScore && dScore >= scoreDrop)) {
      blunders.push({
        moveNo: curNo,
        color: isBlack ? "B" : "W",
        vertex: moves[curNo - 1]?.[1] ?? "",
        winrateDrop: Number(dWr.toFixed(4)),
        scoreDrop: hasScore ? Number(dScore.toFixed(1)) : null,
        winrate: cur.winrate,
        scoreLead: cur.scoreLead ?? null,
      });
    }
  }
  return blunders;
}

// Format score lead text cleanly (always Black perspective input).
export function formatScoreLead(scoreLead, labels = { black: "B", white: "W", even: "Even" }) {
  if (typeof scoreLead !== "number" || !Number.isFinite(scoreLead)) return "";
  const abs = Math.abs(scoreLead);
  if (abs < 0.05) return labels.even;
  const side = scoreLead > 0 ? labels.black : labels.white;
  return `${side}+${abs.toFixed(1)}`;
}

// Non-blocking analyzer queue: keeps at most one in-flight request to the bridge
// and coalesces rapid move updates so only the latest position is evaluated.
export class AnalysisManager extends EventTarget {
  constructor() {
    super();
    this.bridge = null;
    this.inFlight = false;
    this.pending = null;
    this.seq = 0;
    this.activeKey = null;
    this.ownershipCache = new Map(); // `${gameKey}:${moveNo}` -> Float32Array/number[]
    this.maxOwnershipEntries = 24;
  }

  setBridge(client) {
    this.bridge = client || null;
    if (!this.bridge) {
      this.pending = null;
      this.activeKey = null;
    }
  }

  get capable() {
    const info = this.bridge?.info;
    return !!(this.bridge?.connected && info && (info.canAnalyze || info.commands?.includes("kata-analyze") || info.commands?.includes("lz-analyze")));
  }

  get proto() {
    const info = this.bridge?.info;
    if (!info) return null;
    if (info.analyzeProto) return info.analyzeProto;
    if (info.commands?.includes("kata-analyze")) return "kata";
    if (info.commands?.includes("lz-analyze")) return "lz";
    return null;
  }

  getOwnership(gameKey, moveNo) {
    return this.ownershipCache.get(`${gameKey}:${moveNo}`) ?? null;
  }

  clearOwnership(gameKey = null) {
    if (!gameKey) {
      this.ownershipCache.clear();
      return;
    }
    const prefix = `${gameKey}:`;
    for (const k of this.ownershipCache.keys()) {
      if (k.startsWith(prefix)) this.ownershipCache.delete(k);
    }
  }

  _putOwnership(gameKey, moveNo, own) {
    if (!Array.isArray(own) || !own.length) return;
    const key = `${gameKey}:${moveNo}`;
    this.ownershipCache.delete(key);
    this.ownershipCache.set(key, own);
    while (this.ownershipCache.size > this.maxOwnershipEntries) {
      const oldest = this.ownershipCache.keys().next().value;
      this.ownershipCache.delete(oldest);
    }
  }

  cancel() {
    this.pending = null;
    this.seq++;
    if (this.inFlight && this.bridge?.connected) {
      this.bridge.request("cancel_analyze", {}, 3000).catch(() => {});
    }
  }

  // Schedule analysis for a position. Newer calls preempt/coalesce older ones.
  // job: { gameKey, moveNo, size, komi, color, moves, maxTimeMs, maxVisits, maxMoves, includeOwnership }
  request(job) {
    if (!this.capable) return;
    const mySeq = ++this.seq;
    this.pending = { ...DEFAULT_ANALYSIS_OPTIONS, ...job, seq: mySeq };
    if (this.inFlight) {
      this.bridge.request("cancel_analyze", {}, 3000).catch(() => {});
      return;
    }
    this._drain();
  }

  async _drain() {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      while (this.pending && this.capable) {
        const job = this.pending;
        this.pending = null;
        this.activeKey = `${job.gameKey}:${job.moveNo}`;
        this.dispatchEvent(new CustomEvent("busy", { detail: { busy: true, job } }));
        try {
          const res = await this.bridge.request(
            "analyze",
            {
              size: job.size,
              komi: job.komi,
              color: job.color,
              moves: job.moves.map(([c, v]) => [c, v]),
              maxTimeMs: job.maxTimeMs,
              maxVisits: job.maxVisits,
              maxMoves: job.maxMoves,
              includeOwnership: job.includeOwnership,
            },
            Math.max(10000, (job.maxTimeMs || 500) + 10000),
          );
          if (typeof res.winrate === "number") {
            if (Array.isArray(res.ownership)) {
              this._putOwnership(job.gameKey, job.moveNo, res.ownership);
            }
            const entry = {
              gameKey: job.gameKey,
              moveNo: job.moveNo,
              winrate: res.winrate,
              scoreLead: typeof res.scoreLead === "number" ? res.scoreLead : null,
              visits: res.visits ?? 0,
              moves: Array.isArray(res.moves) ? res.moves : [],
              ownership: Array.isArray(res.ownership) ? res.ownership : null,
              proto: res.proto ?? this.proto,
              stale: job.seq !== this.seq,
            };
            this.dispatchEvent(new CustomEvent("result", { detail: entry }));
          }
        } catch (e) {
          this.dispatchEvent(new CustomEvent("error", { detail: { job, error: e } }));
        }
      }
    } finally {
      this.inFlight = false;
      this.activeKey = null;
      this.dispatchEvent(new CustomEvent("busy", { detail: { busy: false } }));
    }
  }
}
