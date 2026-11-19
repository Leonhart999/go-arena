// SVG goban. Purely a view: callers pass the position to draw.
import { BLACK, WHITE, EMPTY, GTP_COLS } from "./go.js";

const NS = "http://www.w3.org/2000/svg";
const MARGIN = 1.1;

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
    const gb = el("radialGradient", { id: "stone-b", cx: "35%", cy: "30%", r: "70%" }, defs);
    el("stop", { offset: "0%", "stop-color": "#6b6b6b" }, gb);
    el("stop", { offset: "100%", "stop-color": "#0d0d0d" }, gb);
    const gw = el("radialGradient", { id: "stone-w", cx: "35%", cy: "30%", r: "75%" }, defs);
    el("stop", { offset: "0%", "stop-color": "#ffffff" }, gw);
    el("stop", { offset: "100%", "stop-color": "#c9c6bd" }, gw);

    this.gridLayer = el("g", {}, this.svg);
    this.ownerLayer = el("g", {}, this.svg);
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
    const local = pt.matrixTransform(this.svg.getScreenCTM().inverse());
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
    el("rect", { x: 0, y: 0, width: span, height: span, class: "wood" }, g);
    for (let i = 0; i < size; i++) {
      const c = MARGIN + i;
      el("line", { x1: MARGIN, y1: c, x2: MARGIN + size - 1, y2: c, class: "line" }, g);
      el("line", { x1: c, y1: MARGIN, x2: c, y2: MARGIN + size - 1, class: "line" }, g);
      const label = { class: "coord", "text-anchor": "middle", "dominant-baseline": "central" };
      el("text", { ...label, x: c, y: MARGIN * 0.42 }, g).textContent = GTP_COLS[i];
      el("text", { ...label, x: c, y: span - MARGIN * 0.42 }, g).textContent = GTP_COLS[i];
      el("text", { ...label, x: MARGIN * 0.42, y: c }, g).textContent = String(size - i);
      el("text", { ...label, x: span - MARGIN * 0.42, y: c }, g).textContent = String(size - i);
    }
    for (const [x, y] of starPoints(size)) el("circle", { cx: MARGIN + x, cy: MARGIN + y, r: 0.09, class: "star" }, g);
  }

  // position: { size, stones: Uint8Array, lastPoint, owner?: Uint8Array }
  render(position) {
    this.position = position;
    if (position.size !== this.size) this.drawGrid(position.size);
    const { size, stones, lastPoint, owner } = position;

    this.ownerLayer.replaceChildren();
    if (owner) {
      for (let p = 0; p < owner.length; p++) {
        if (!owner[p] || stones[p] === owner[p]) continue;
        const x = p % size;
        const y = (p - x) / size;
        el("rect", {
          x: MARGIN + x - 0.16, y: MARGIN + y - 0.16, width: 0.32, height: 0.32,
          class: owner[p] === BLACK ? "own-b" : "own-w",
        }, this.ownerLayer);
      }
    }

    this.stoneLayer.replaceChildren();
    for (let p = 0; p < stones.length; p++) {
      const s = stones[p];
      if (s === EMPTY) continue;
      const x = p % size;
      const y = (p - x) / size;
      el("circle", {
        cx: MARGIN + x, cy: MARGIN + y, r: 0.475,
        fill: s === BLACK ? "url(#stone-b)" : "url(#stone-w)",
        class: s === WHITE ? "stone white" : "stone black",
      }, this.stoneLayer);
    }

    this.markLayer.replaceChildren();
    if (lastPoint !== null && lastPoint !== undefined && lastPoint >= 0 && stones[lastPoint] !== EMPTY) {
      const x = lastPoint % size;
      const y = (lastPoint - x) / size;
      el("circle", {
        cx: MARGIN + x, cy: MARGIN + y, r: 0.2,
        class: stones[lastPoint] === BLACK ? "last on-black" : "last on-white",
      }, this.markLayer);
    }
  }
}
