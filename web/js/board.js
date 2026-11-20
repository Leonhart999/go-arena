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
  constructor(container, { onClick } = {}) {
    this.onClick = onClick;
    this.size = 0;
    this.interactiveColor = null; // BLACK/WHITE when a local human may click
    this.position = null;
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
    this.ghost = el("circle", { r: 0.47, class: "ghost", visibility: "hidden" }, this.svg);

    this.svg.addEventListener("click", (e) => {
      const p = this.pointAt(e);
      if (p !== null && this.interactiveColor && this.onClick) this.onClick(p);
    });
    this.svg.addEventListener("mousemove", (e) => this.updateGhost(this.pointAt(e)));
    this.svg.addEventListener("mouseleave", () => this.updateGhost(null));
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
    if (point === null || !this.interactiveColor || !stones || stones[point] !== EMPTY) {
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
    this.interactiveColor = color;
    this.svg.classList.toggle("interactive", !!color);
    if (!color) this.updateGhost(null);
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

  // position: { size, stones: Uint8Array, lastPoint, owner?: Uint8Array, moveNumbers?: Map<number, number> }
  render(position) {
    this.position = position;
    if (position.size !== this.size) this.drawGrid(position.size);
    const { size, stones, lastPoint, owner, moveNumbers } = position;

    this.ownerLayer.replaceChildren();
    if (owner) {
      for (let p = 0; p < owner.length; p++) {
        if (!owner[p] || stones[p] === owner[p]) continue;
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
      el("circle", {
        cx: cx + 0.055, cy: cy + 0.075, r: 0.468,
        class: "stone-shadow",
      }, this.shadowLayer);
      el("circle", {
        cx, cy, r: 0.476,
        fill: s === BLACK ? "url(#stone-b)" : "url(#stone-w)",
        class: s === WHITE ? "stone white" : "stone black",
      }, this.stoneLayer);
    }

    this.markLayer.replaceChildren();
    if (moveNumbers && moveNumbers.size) {
      for (const [p, num] of moveNumbers) {
        if (stones[p] === EMPTY) continue;
        const x = p % size;
        const y = (p - x) / size;
        const digits = String(num).length;
        const fz = digits >= 3 ? 0.31 : digits === 2 ? 0.37 : 0.42;
        const isLast = p === lastPoint;
        const cls = [
          "move-num",
          stones[p] === BLACK ? "on-black" : "on-white",
          isLast ? "is-last" : "",
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
  }
}
