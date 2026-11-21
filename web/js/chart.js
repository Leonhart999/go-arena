// Pure SVG winrate & score-lead chart with hover inspection, blunder markers,
// and click-to-jump navigation. Zero external dependencies.

const NS = "http://www.w3.org/2000/svg";

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

// Compute symmetric score-axis ceiling so the chart scales smoothly.
export function computeScoreCeiling(points) {
  let maxAbs = 10;
  for (const p of points) {
    if (typeof p.scoreLead === "number" && Number.isFinite(p.scoreLead)) {
      maxAbs = Math.max(maxAbs, Math.abs(p.scoreLead));
    }
  }
  const steps = [10, 15, 20, 30, 50, 80, 120, 200];
  for (const s of steps) {
    if (maxAbs <= s) return s;
  }
  return Math.ceil(maxAbs / 50) * 50;
}

export class AnalysisChart {
  constructor(container, { onSelectMove, formatTooltip } = {}) {
    this.container = container;
    this.onSelectMove = onSelectMove || null;
    this.formatTooltip = formatTooltip || null;
    this.mode = "winrate"; // "winrate" | "score" | "both"
    this.state = null; // last rendered payload
    this.hoverMove = null;

    this.svg = el("svg", {
      class: "eval-chart-svg",
      viewBox: "0 0 400 132",
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": "Winrate and score chart",
    });
    this.container.replaceChildren(this.svg);

    this.tooltip = document.createElement("div");
    this.tooltip.className = "chart-tooltip";
    this.tooltip.hidden = true;
    this.container.appendChild(this.tooltip);

    this.bgLayer = el("g", {}, this.svg);
    this.dataLayer = el("g", {}, this.svg);
    this.overlayLayer = el("g", {}, this.svg);
    this.hitRect = el("rect", {
      x: 0,
      y: 0,
      width: 400,
      height: 132,
      fill: "transparent",
      class: "chart-hit",
    }, this.svg);

    this.hitRect.addEventListener("mousemove", (e) => this._onPointer(e, false));
    this.hitRect.addEventListener("mouseleave", () => {
      this.hoverMove = null;
      this.tooltip.hidden = true;
      this._drawOverlay();
    });
    this.hitRect.addEventListener("click", (e) => this._onPointer(e, true));
  }

  setMode(mode) {
    if (mode === "winrate" || mode === "score" || mode === "both") {
      this.mode = mode;
      if (this.state) this.render(this.state);
    }
  }

  _metrics() {
    return { W: 400, H: 132, padL: 30, padR: 12, padT: 10, padB: 20 };
  }

  // payload: { points: [{moveNo, winrate, scoreLead}], blunders: [{moveNo, ...}], totalMoves, currentMove, emptyText }
  render(payload) {
    this.state = payload;
    const { points = [], blunders = [], totalMoves = 0, emptyText = "" } = payload || {};
    const { W, H, padL, padR, padT, padB } = this._metrics();
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    this.bgLayer.replaceChildren();
    this.dataLayer.replaceChildren();

    const sorted = points
      .filter((p) => p && Number.isInteger(p.moveNo) && typeof p.winrate === "number")
      .sort((a, b) => a.moveNo - b.moveNo);

    const maxMove = Math.max(10, totalMoves, sorted.length ? sorted[sorted.length - 1].moveNo : 0);
    const scoreCeil = computeScoreCeiling(sorted);

    const xOf = (m) => padL + (maxMove > 0 ? (m / maxMove) * plotW : 0);
    const yWr = (wr) => padT + (1 - Math.max(0, Math.min(1, wr))) * plotH;
    const yScore = (sl) => {
      const clamped = Math.max(-scoreCeil, Math.min(scoreCeil, sl));
      return padT + ((scoreCeil - clamped) / (2 * scoreCeil)) * plotH;
    };

    this._coords = { sorted, blunders, maxMove, scoreCeil, xOf, yWr, yScore, padL, padR, padT, padB, plotW, plotH };

    // Background grid & labels
    el("rect", { x: padL, y: padT, width: plotW, height: plotH, class: "chart-plot-bg" }, this.bgLayer);
    const midY = padT + plotH / 2;
    el("line", { x1: padL, y1: midY, x2: padL + plotW, y2: midY, class: "chart-midline" }, this.bgLayer);
    for (const frac of [0.25, 0.75]) {
      const gy = padT + frac * plotH;
      el("line", { x1: padL, y1: gy, x2: padL + plotW, y2: gy, class: "chart-gridline" }, this.bgLayer);
    }

    const yLabels = this.mode === "score"
      ? [[padT + 4, `+${scoreCeil}`], [midY, "0"], [padT + plotH - 2, `-${scoreCeil}`]]
      : [[padT + 4, "100"], [midY, "50%"], [padT + plotH - 2, "0"]];
    for (const [y, txt] of yLabels) {
      el("text", { x: padL - 5, y, class: "chart-axis-text", "text-anchor": "end", "dominant-baseline": "central" }, this.bgLayer).textContent = txt;
    }

    // X-axis ticks (0, mid, max)
    const xTicks = [0, Math.round(maxMove / 2), maxMove];
    for (const m of xTicks) {
      el("text", {
        x: xOf(m),
        y: H - 5,
        class: "chart-axis-text",
        "text-anchor": m === 0 ? "start" : m === maxMove ? "end" : "middle",
      }, this.bgLayer).textContent = String(m);
    }

    if (!sorted.length) {
      el("text", {
        x: padL + plotW / 2,
        y: midY,
        class: "chart-empty-text",
        "text-anchor": "middle",
        "dominant-baseline": "central",
      }, this.dataLayer).textContent = emptyText;
      this._drawOverlay();
      return;
    }

    const showWr = this.mode === "winrate" || this.mode === "both";
    const showScore = this.mode === "score" || this.mode === "both";

    // Area fill under winrate curve (above 50% = Black, below = White tint)
    if (showWr && sorted.length >= 2) {
      const firstX = xOf(sorted[0].moveNo);
      const lastX = xOf(sorted[sorted.length - 1].moveNo);
      const dLine = sorted.map((p, idx) => `${idx === 0 ? "M" : "L"}${xOf(p.moveNo).toFixed(1)},${yWr(p.winrate).toFixed(1)}`).join(" ");
      const dArea = `${dLine} L${lastX.toFixed(1)},${midY.toFixed(1)} L${firstX.toFixed(1)},${midY.toFixed(1)} Z`;
      el("path", { d: dArea, class: "chart-wr-area" }, this.dataLayer);
      el("path", { d: dLine, class: "chart-wr-line" }, this.dataLayer);
    } else if (showWr && sorted.length === 1) {
      el("circle", { cx: xOf(sorted[0].moveNo), cy: yWr(sorted[0].winrate), r: 3, class: "chart-wr-dot" }, this.dataLayer);
    }

    // Score lead curve
    if (showScore) {
      const scorePts = sorted.filter((p) => typeof p.scoreLead === "number" && Number.isFinite(p.scoreLead));
      if (scorePts.length >= 2) {
        const dScore = scorePts.map((p, idx) => `${idx === 0 ? "M" : "L"}${xOf(p.moveNo).toFixed(1)},${yScore(p.scoreLead).toFixed(1)}`).join(" ");
        el("path", {
          d: dScore,
          class: this.mode === "both" ? "chart-score-line dashed" : "chart-score-line",
        }, this.dataLayer);
      } else if (scorePts.length === 1) {
        el("circle", { cx: xOf(scorePts[0].moveNo), cy: yScore(scorePts[0].scoreLead), r: 3, class: "chart-score-dot" }, this.dataLayer);
      }
    }

    // Blunder markers
    const blunderSet = new Set(blunders.map((b) => b.moveNo));
    for (const p of sorted) {
      if (!blunderSet.has(p.moveNo)) continue;
      const cx = xOf(p.moveNo);
      const cy = this.mode === "score" && typeof p.scoreLead === "number" ? yScore(p.scoreLead) : yWr(p.winrate);
      el("circle", { cx, cy, r: 3.6, class: "chart-blunder-dot" }, this.dataLayer);
    }

    this._drawOverlay();
  }

  _drawOverlay() {
    this.overlayLayer.replaceChildren();
    if (!this._coords || !this.state) return;
    const { sorted, xOf, yWr, yScore, padT, plotH } = this._coords;
    const curMove = this.state.currentMove;

    if (typeof curMove === "number" && curMove >= 0) {
      const cx = xOf(curMove);
      el("line", { x1: cx, y1: padT, x2: cx, y2: padT + plotH, class: "chart-cursor" }, this.overlayLayer);
      const pt = sorted.find((p) => p.moveNo === curMove);
      if (pt) {
        const cy = this.mode === "score" && typeof pt.scoreLead === "number" ? yScore(pt.scoreLead) : yWr(pt.winrate);
        el("circle", { cx, cy, r: 3.8, class: "chart-cursor-dot" }, this.overlayLayer);
      }
    }

    if (this.hoverMove !== null) {
      const hx = xOf(this.hoverMove);
      el("line", { x1: hx, y1: padT, x2: hx, y2: padT + plotH, class: "chart-hover-line" }, this.overlayLayer);
    }
  }

  _nearestPoint(event) {
    if (!this._coords) return null;
    const { sorted, maxMove, padL, plotW, W } = this._coords;
    const rect = this.svg.getBoundingClientRect();
    if (!rect.width) return null;
    const svgX = ((event.clientX - rect.left) / rect.width) * W;
    const frac = Math.max(0, Math.min(1, (svgX - padL) / plotW));
    const approxMove = Math.round(frac * maxMove);
    if (!sorted.length) return { moveNo: approxMove, point: null, rect, clientX: event.clientX };
    let best = sorted[0];
    let bestDist = Math.abs(best.moveNo - approxMove);
    for (const p of sorted) {
      const d = Math.abs(p.moveNo - approxMove);
      if (d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
    return { moveNo: bestDist <= Math.max(3, maxMove * 0.04) ? best.moveNo : approxMove, point: best, rect, clientX: event.clientX };
  }

  _onPointer(event, isClick) {
    const hit = this._nearestPoint(event);
    if (!hit) return;
    if (isClick) {
      if (this.onSelectMove) this.onSelectMove(hit.moveNo);
      return;
    }
    this.hoverMove = hit.point ? hit.point.moveNo : hit.moveNo;
    this._drawOverlay();
    if (hit.point) {
      const text = this.formatTooltip
        ? this.formatTooltip(hit.point)
        : `#${hit.point.moveNo} · B ${(hit.point.winrate * 100).toFixed(1)}%`;
      this.tooltip.textContent = text;
      this.tooltip.hidden = false;
      const relX = hit.clientX - hit.rect.left;
      const clamped = Math.max(8, Math.min(hit.rect.width - 140, relX + 10));
      this.tooltip.style.left = `${clamped}px`;
    } else {
      this.tooltip.hidden = true;
    }
  }
}
