// SVG goban. Purely a view: callers pass the position to draw.
import { BLACK, WHITE, EMPTY, GTP_COLS } from "./go.js";

const NS = "http://www.w3.org/2000/svg";
const MARGIN = 1.18;

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function starPoints(size) {
  if (size < 7) return [];
  const edge = size >= 13 ? 3 : 2;
  const far = size - 1 - edge;
  const pts = [[edge, edge], [edge, far], [far, edge], [far, far]];
  if (size % 2 === 1 && size >= 9) {
    const mid = (size - 1) / 2;
    pts.push([mid, mid]);
    if (size >= 13) pts.push([edge, mid], [far, mid], [mid, edge], [mid, far]);
  }
  return pts;
}

export class BoardView {
  constructor(container, { onClick, onHoverCandidate } = {}) {
    this.onClick = onClick;
    this.onHoverCandidate = onHoverCandidate || null;
    this.size = 0;
    this.interactiveColor = null; // BLACK/WHITE when a local human may click
    this.position = null;
    this.hoveredCandidate = null; // candidate move string when hovering an AI suggestion
    this.svg = el("svg", { class: "goban", role: "img", "aria-label": "Go board" });
    container.appendChild(this.svg);

    const defs = el("defs", {}, this.svg);

    // Warm Kaya wood surface sheen
    const wood = el("linearGradient", { id: "kaya-wood", x1: "0%", y1: "0%", x2: "100%", y2: "100%" }, defs);
    el("stop", { offset: "0%", "stop-color": "var(--wood-hi)" }, wood);
    el("stop", { offset: "52%", "stop-color": "var(--wood)" }, wood);
    el("stop", { offset: "100%", "stop-color": "var(--wood-lo)" }, wood);

    // Subtle wood grain pattern
    const grain = el("pattern", { id: "kaya-grain", width: "4", height: "4", patternUnits: "userSpaceOnUse" }, defs);
    el("line", { x1: "0", y1: "0.7", x2: "4", y2: "0.7", stroke: "#7a5219", "stroke-opacity": "0.045", "stroke-width": "0.14" }, grain);
    el("line", { x1: "0", y1: "2.1", x2: "4", y2: "2.1", stroke: "#5c3b0e", "stroke-opacity": "0.035", "stroke-width": "0.09" }, grain);
    el("line", { x1: "0", y1: "3.3", x2: "4", y2: "3.3", stroke: "#fff5d6", "stroke-opacity": "0.05", "stroke-width": "0.11" }, grain);

    // Slate black stone gradient
    const gb = el("radialGradient", { id: "stone-b", cx: "32%", cy: "28%", r: "70%" }, defs);
    el("stop", { offset: "0%", "stop-color": "#585c63" }, gb);
    el("stop", { offset: "38%", "stop-color": "#23262b" }, gb);
    el("stop", { offset: "100%", "stop-color": "#0b0c0e" }, gb);

    // Clamshell white stone gradient
    const gw = el("radialGradient", { id: "stone-w", cx: "33%", cy: "27%", r: "74%" }, defs);
    el("stop", { offset: "0%", "stop-color": "#ffffff" }, gw);
    el("stop", { offset: "65%", "stop-color": "#f3efe6" }, gw);
    el("stop", { offset: "100%", "stop-color": "#ccc5b8" }, gw);

    this.gridLayer = el("g", {}, this.svg);
    this.ownerLayer = el("g", {}, this.svg);
    this.shadowLayer = el("g", {}, this.svg);
    this.stoneLayer = el("g", {}, this.svg);
    this.markLayer = el("g", {}, this.svg);
    this.candidateLayer = el("g", {}, this.svg);
    this.pvLayer = el("g", {}, this.svg);
    this.ghost = el("circle", { r: 0.47, class: "ghost", visibility: "hidden" }, this.svg);

    this.svg.addEventListener("click", (e) => {
      const p = this.pointAt(e);
      if (p !== null && this.interactiveColor && this.onClick) this.onClick(p);
    });
    this.svg.addEventListener("mousemove", (e) => {
      const p = this.pointAt(e);
      this.updateGhost(p);
      this._updateCandidateHover(p);
    });
    this.svg.addEventListener("mouseleave", () => {
      this.updateGhost(null);
      this._updateCandidateHover(null);
    });
  }

  pointAt(event) {
    if (!this.size) return null;
    const pt = this.svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const ctm = this.svg.getScreenCTM();
    if (!ctm) return null;
    const local = pt.matrixTransform(ctm.inverse());
    const x = Math.round(local.x - MARGIN);
    const y = Math.round(local.y - MARGIN);
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return null;
    return y * this.size + x;
  }

  updateGhost(point) {
    const stones = this.position?.stones;
    if (point === null || (this.interactiveColor !== BLACK && this.interactiveColor !== WHITE) || !stones || stones[point] !== EMPTY) {
      this.ghost.setAttribute("visibility", "hidden");
      return;
    }
    const x = point % this.size;
    const y = (point - x) / this.size;
    this.ghost.setAttribute("cx", MARGIN + x);
    this.ghost.setAttribute("cy", MARGIN + y);
    this.ghost.setAttribute("fill", this.interactiveColor === BLACK ? "url(#stone-b)" : "url(#stone-w)");
    this.ghost.setAttribute("visibility", "visible");
  }

  setInteractive(color) {
    // color: BLACK | WHITE | "dead" | null
    this.interactiveColor = color;
    this.svg.classList.toggle("interactive", !!color);
    if (!color || color === "dead") this.updateGhost(null);
  }

  drawGrid(size) {
    this.size = size;
    const g = this.gridLayer;
    g.replaceChildren();
    const span = size - 1 + 2 * MARGIN;
    this.svg.setAttribute("viewBox", `0 0 ${span} ${span}`);

    el("rect", { x: 0, y: 0, width: span, height: span, rx: 0.22, fill: "url(#kaya-wood)", class: "wood" }, g);
    el("rect", { x: 0, y: 0, width: span, height: span, rx: 0.22, fill: "url(#kaya-grain)", "pointer-events": "none" }, g);

    const fontSize = size <= 9 ? 0.36 : size <= 13 ? 0.39 : 0.42;
    const coordOffset = MARGIN * 0.43;

    for (let i = 0; i < size; i++) {
      const c = MARGIN + i;
      const isEdge = i === 0 || i === size - 1;
      const cls = isEdge ? "line edge" : "line";
      el("line", { x1: MARGIN, y1: c, x2: MARGIN + size - 1, y2: c, class: cls }, g);
      el("line", { x1: c, y1: MARGIN, x2: c, y2: MARGIN + size - 1, class: cls }, g);

      const label = {
        class: "coord",
        "font-size": `${fontSize}px`,
        "text-anchor": "middle",
        "dominant-baseline": "central",
      };
      el("text", { ...label, x: c, y: coordOffset }, g).textContent = GTP_COLS[i];
      el("text", { ...label, x: c, y: span - coordOffset }, g).textContent = GTP_COLS[i];
      el("text", { ...label, x: coordOffset, y: c }, g).textContent = String(size - i);
      el("text", { ...label, x: span - coordOffset, y: c }, g).textContent = String(size - i);
    }

    const starR = size <= 9 ? 0.1 : 0.095;
    for (const [x, y] of starPoints(size)) {
      el("circle", { cx: MARGIN + x, cy: MARGIN + y, r: starR, class: "star" }, g);
    }
  }

  _gtpToPoint(vertex) {
    const v = String(vertex ?? "").trim().toUpperCase();
    if (!v || v === "PASS" || v === "RESIGN") return -1;
    const x = GTP_COLS.indexOf(v[0]);
    const row = Number(v.slice(1));
    if (x < 0 || !Number.isInteger(row)) return -1;
    const y = this.size - row;
    if (x >= this.size || y < 0 || y >= this.size) return -1;
    return y * this.size + x;
  }

  _updateCandidateHover(point) {
    const cands = this.position?.candidates;
    let found = null;
    if (point !== null && Array.isArray(cands) && cands.length) {
      for (const c of cands) {
        if (this._gtpToPoint(c.move) === point) {
          found = c;
          break;
        }
      }
    }
    const nextMove = found ? found.move : null;
    if (nextMove !== this.hoveredCandidate) {
      this.hoveredCandidate = nextMove;
      this._renderPv(found);
      if (this.onHoverCandidate) this.onHoverCandidate(found);
    }
  }

  _renderPv(candidate) {
    this.pvLayer.replaceChildren();
    if (!candidate || !Array.isArray(candidate.pv) || !candidate.pv.length || !this.position) return;
    const { size, stones, toPlay } = this.position;
    let color = toPlay === WHITE ? WHITE : BLACK;
    const placed = new Set();
    const maxLen = Math.min(12, candidate.pv.length);
    for (let i = 0; i < maxLen; i++) {
      const p = this._gtpToPoint(candidate.pv[i]);
      const stepColor = color;
      color = color === BLACK ? WHITE : BLACK;
      if (p < 0 || placed.has(p)) continue;
      if (stones[p] !== EMPTY) continue;
      placed.add(p);
      const x = p % size;
      const y = (p - x) / size;
      const cx = MARGIN + x;
      const cy = MARGIN + y;
      el("circle", {
        cx,
        cy,
        r: 0.455,
        fill: stepColor === BLACK ? "url(#stone-b)" : "url(#stone-w)",
        class: stepColor === WHITE ? "pv-stone white" : "pv-stone black",
      }, this.pvLayer);
      const num = i + 1;
      const fz = num >= 10 ? 0.34 : 0.4;
      el("text", {
        x: cx,
        y: cy + 0.02,
        class: stepColor === BLACK ? "pv-num on-black" : "pv-num on-white",
        "font-size": `${fz}px`,
        "text-anchor": "middle",
        "dominant-baseline": "central",
      }, this.pvLayer).textContent = String(num);
    }
  }

  // position: {
  //   size, stones: Uint8Array, lastPoint,
  //   owner?: Uint8Array,                // discrete Tromp-Taylor ownership (1=B, 2=W)
  //   ownership?: number[],              // continuous AI ownership in [-1, 1] (+1=B, -1=W)
  //   deadPoints?: Set<number>,          // stones marked dead during human scoring
  //   moveNumbers?: Map<number, number>,
  //   variationPoints?: Set<number>,     // stones placed in a review variation branch
  //   candidates?: [{move, winrate, scoreLead, visits, pv}],
  //   toPlay?: BLACK | WHITE,
  // }
  render(position) {
    this.position = position;
    if (position.size !== this.size) this.drawGrid(position.size);
    const { size, stones, lastPoint, owner, ownership, deadPoints, moveNumbers, variationPoints, candidates, toPlay } = position;

    this.ownerLayer.replaceChildren();
    if (Array.isArray(ownership) && ownership.length === size * size) {
      for (let p = 0; p < ownership.length; p++) {
        const v = ownership[p];
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        const mag = Math.min(1, Math.abs(v));
        if (mag < 0.12) continue;
        const x = p % size;
        const y = (p - x) / size;
        const side = 0.18 + mag * 0.64;
        const opacity = (0.14 + mag * 0.44).toFixed(2);
        el("rect", {
          x: MARGIN + x - side / 2,
          y: MARGIN + y - side / 2,
          width: side,
          height: side,
          rx: 0.08,
          class: v > 0 ? "own-heat-b" : "own-heat-w",
          "fill-opacity": opacity,
        }, this.ownerLayer);
      }
    } else if (owner) {
      for (let p = 0; p < owner.length; p++) {
        const isDead = deadPoints?.has(p);
        if (!owner[p] || (!isDead && stones[p] === owner[p])) continue;
        const x = p % size;
        const y = (p - x) / size;
        el("rect", {
          x: MARGIN + x - 0.16, y: MARGIN + y - 0.16, width: 0.32, height: 0.32, rx: 0.05,
          class: owner[p] === BLACK ? "own-b" : "own-w",
        }, this.ownerLayer);
      }
    }

    this.shadowLayer.replaceChildren();
    this.stoneLayer.replaceChildren();
    for (let p = 0; p < stones.length; p++) {
      const s = stones[p];
      if (s === EMPTY) continue;
      const x = p % size;
      const y = (p - x) / size;
      const cx = MARGIN + x;
      const cy = MARGIN + y;
      const isDead = deadPoints?.has(p);
      el("circle", {
        cx: cx + 0.055, cy: cy + 0.075, r: 0.468,
        class: isDead ? "stone-shadow dead" : "stone-shadow",
      }, this.shadowLayer);
      el("circle", {
        cx, cy, r: 0.476,
        fill: s === BLACK ? "url(#stone-b)" : "url(#stone-w)",
        class: [s === WHITE ? "stone white" : "stone black", isDead ? "dead" : ""].filter(Boolean).join(" "),
      }, this.stoneLayer);
    }

    this.markLayer.replaceChildren();
    if (deadPoints && deadPoints.size) {
      for (const p of deadPoints) {
        if (stones[p] === EMPTY) continue;
        const x = p % size;
        const y = (p - x) / size;
        const cx = MARGIN + x;
        const cy = MARGIN + y;
        const d = 0.22;
        el("line", { x1: cx - d, y1: cy - d, x2: cx + d, y2: cy + d, class: "dead-x" }, this.markLayer);
        el("line", { x1: cx + d, y1: cy - d, x2: cx - d, y2: cy + d, class: "dead-x" }, this.markLayer);
      }
    }
    if (moveNumbers && moveNumbers.size) {
      for (const [p, num] of moveNumbers) {
        if (stones[p] === EMPTY) continue;
        const x = p % size;
        const y = (p - x) / size;
        const digits = String(num).length;
        const fz = digits >= 3 ? 0.31 : digits === 2 ? 0.37 : 0.42;
        const isLast = p === lastPoint;
        const isVar = variationPoints?.has(p);
        const cls = [
          "move-num",
          stones[p] === BLACK ? "on-black" : "on-white",
          isLast ? "is-last" : "",
          isVar ? "is-var" : "",
        ].filter(Boolean).join(" ");
        el("text", {
          x: MARGIN + x,
          y: MARGIN + y + 0.02,
          class: cls,
          "font-size": `${fz}px`,
          "text-anchor": "middle",
          "dominant-baseline": "central",
        }, this.markLayer).textContent = String(num);
      }
    } else if (lastPoint !== null && lastPoint !== undefined && lastPoint >= 0 && stones[lastPoint] !== EMPTY) {
      const x = lastPoint % size;
      const y = (lastPoint - x) / size;
      el("circle", {
        cx: MARGIN + x, cy: MARGIN + y, r: 0.21,
        class: stones[lastPoint] === BLACK ? "last on-black" : "last on-white",
      }, this.markLayer);
    }

    // AI recommended candidate bubbles
    this.candidateLayer.replaceChildren();
    this.pvLayer.replaceChildren();
    if (Array.isArray(candidates) && candidates.length) {
      const sideIsBlack = toPlay !== WHITE;
      candidates.slice(0, 5).forEach((cand, idx) => {
        const p = this._gtpToPoint(cand.move);
        if (p < 0 || stones[p] !== EMPTY) return;
        const x = p % size;
        const y = (p - x) / size;
        const cx = MARGIN + x;
        const cy = MARGIN + y;
        const tier = idx === 0 ? "best" : idx === 1 ? "good" : "alt";
        el("circle", {
          cx,
          cy,
          r: idx === 0 ? 0.45 : 0.41,
          class: `cand-ring ${tier}`,
        }, this.candidateLayer);
        // Show mover's winrate % on top line and scoreLead or visits on bottom line
        const moverWr = sideIsBlack ? cand.winrate : 1 - cand.winrate;
        const wrText = `${(moverWr * 100).toFixed(0)}%`;
        el("text", {
          x: cx,
          y: cy - (typeof cand.scoreLead === "number" ? 0.11 : 0.01),
          class: `cand-wr ${tier}`,
          "font-size": "0.27px",
          "text-anchor": "middle",
          "dominant-baseline": "central",
        }, this.candidateLayer).textContent = wrText;

        if (typeof cand.scoreLead === "number" && Number.isFinite(cand.scoreLead)) {
          const moverLead = sideIsBlack ? cand.scoreLead : -cand.scoreLead;
          const sign = moverLead > 0.05 ? "+" : "";
          el("text", {
            x: cx,
            y: cy + 0.16,
            class: `cand-sub ${tier}`,
            "font-size": "0.21px",
            "text-anchor": "middle",
            "dominant-baseline": "central",
          }, this.candidateLayer).textContent = `${sign}${moverLead.toFixed(1)}`;
        }
      });
      // Re-render hovered PV if cursor is still on a valid candidate
      if (this.hoveredCandidate) {
        const still = candidates.find((c) => c.move === this.hoveredCandidate);
        if (still) this._renderPv(still);
        else this.hoveredCandidate = null;
      }
    } else {
      this.hoveredCandidate = null;
    }
  }
}
