// SGF import & export for game records (SGF FF[4], single game or collection).
import { BLACK, Board, SGF_COLS, colorFromLetter } from "./go.js";

const escape = (text) => String(text ?? "").replace(/\\/g, "\\\\").replace(/]/g, "\\]");

function unescapeSgf(text) {
  return String(text ?? "").replace(/\\([\s\S])/g, "$1");
}

function sgfCoordToGtp(coord, board) {
  const c = String(coord ?? "").trim();
  if (!c) return "pass";
  if (c.length !== 2) return null;
  // Special FF[4] pass coordinate "tt" on <=19x19 boards
  if (board.size <= 19 && c === "tt") return "pass";
  const x = SGF_COLS.indexOf(c[0]);
  const y = SGF_COLS.indexOf(c[1]);
  if (x < 0 || y < 0 || x >= board.size || y >= board.size) return null;
  return board.toGtp(y * board.size + x);
}

// Parse optional embedded eval comment produced by recordToSgf, e.g. "1.2s | B 61.2% | B+1.5"
function parseCommentEval(comment, moveNo) {
  if (!comment) return null;
  const wrM = /\bB\s+(\d+(?:\.\d+)?)%/.exec(comment);
  if (!wrM) return null;
  const winrate = Math.max(0, Math.min(1, Number(wrM[1]) / 100));
  let scoreLead = null;
  const slM = /\b([BW])\+(\d+(?:\.\d+)?)\b/.exec(comment);
  if (slM) {
    scoreLead = (slM[1] === "B" ? 1 : -1) * Number(slM[2]);
  }
  return { moveNo, winrate: Number(winrate.toFixed(4)), scoreLead, visits: 0 };
}

function parseCommentMs(comment) {
  if (!comment) return 0;
  const m = /(\d+(?:\.\d+)?)s\b/.exec(comment);
  return m ? Math.round(Number(m[1]) * 1000) : 0;
}

// Minimal recursive-descent SGF parser that extracts the main line of each GameTree.
function extractMainLineTrees(src) {
  const text = String(src ?? "");
  const n = text.length;
  let i = 0;

  const skipWs = () => {
    while (i < n && /\s/.test(text[i])) i++;
  };

  const readPropValue = () => {
    // Assumes text[i] === '['
    i++;
    let out = "";
    while (i < n && text[i] !== "]") {
      if (text[i] === "\\" && i + 1 < n) {
        out += text[i] + text[i + 1];
        i += 2;
      } else {
        out += text[i++];
      }
    }
    if (i < n && text[i] === "]") i++;
    return unescapeSgf(out);
  };

  const readNode = () => {
    // Assumes text[i] === ';'
    i++;
    const props = Object.create(null);
    while (i < n) {
      skipWs();
      if (i >= n || !/[A-Za-z]/.test(text[i])) break;
      let key = "";
      while (i < n && /[A-Za-z]/.test(text[i])) key += text[i++];
      key = key.toUpperCase();
      skipWs();
      const vals = [];
      while (i < n && text[i] === "[") {
        vals.push(readPropValue());
        skipWs();
      }
      if (vals.length) {
        props[key] = props[key] ? props[key].concat(vals) : vals;
      }
    }
    return props;
  };

  const skipTree = () => {
    // Assumes text[i] === '('
    i++;
    let depth = 1;
    while (i < n && depth > 0) {
      const ch = text[i++];
      if (ch === "[") {
        while (i < n && text[i] !== "]") {
          if (text[i] === "\\" && i + 1 < n) i += 2;
          else i++;
        }
        if (i < n) i++;
      } else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
  };

  const readMainTree = () => {
    // Assumes text[i] === '('
    i++;
    const nodes = [];
    let tookFirstSubtree = false;
    while (i < n) {
      skipWs();
      if (i >= n) break;
      const ch = text[i];
      if (ch === ";") {
        nodes.push(readNode());
      } else if (ch === "(") {
        if (!tookFirstSubtree) {
          tookFirstSubtree = true;
          nodes.push(...readMainTree());
        } else {
          skipTree();
        }
      } else if (ch === ")") {
        i++;
        break;
      } else {
        i++;
      }
    }
    return nodes;
  };

  const trees = [];
  while (i < n) {
    skipWs();
    if (i >= n) break;
    if (text[i] === "(") {
      const nodes = readMainTree();
      if (nodes.length) trees.push(nodes);
    } else {
      i++;
    }
  }
  return trees;
}

// Parse one or more SGF games into go-arena record objects ready for review / resume.
export function parseSgfCollection(text, startIndex = 0) {
  const trees = extractMainLineTrees(text);
  if (!trees.length) throw new Error("No valid SGF game tree found");
  const records = [];

  for (const nodes of trees) {
    const root = nodes[0] || {};
    const rawSize = root.SZ?.[0] ?? "19";
    const size = Number(String(rawSize).split(":")[0]);
    if (!Number.isInteger(size) || size < 2 || size > 25) {
      throw new Error(`Unsupported SGF board size: ${rawSize}`);
    }
    const komiRaw = root.KM?.[0];
    const komi = komiRaw !== undefined && Number.isFinite(Number(komiRaw)) ? Number(komiRaw) : 7.5;
    const pb = root.PB?.[0] || "Black";
    const pw = root.PW?.[0] || "White";
    const result = root.RE?.[0] || "?";
    const date = root.DT?.[0] || new Date().toISOString().slice(0, 10);
    const board = new Board(size, "simple");

    const moves = [];
    const analysis = [];

    // Convert AB / AW setup stones (e.g. handicap) into leading moves so GTP engines stay in sync
    for (const c of root.AB || []) {
      const v = sgfCoordToGtp(c, board);
      if (v && v !== "pass") moves.push(["B", v, 0]);
    }
    for (const c of root.AW || []) {
      const v = sgfCoordToGtp(c, board);
      if (v && v !== "pass") moves.push(["W", v, 0]);
    }

    for (const node of nodes) {
      for (const colorKey of ["B", "W"]) {
        if (!node[colorKey]) continue;
        const v = sgfCoordToGtp(node[colorKey][0], board);
        if (!v) continue;
        const comment = node.C?.[0] ?? "";
        const ms = parseCommentMs(comment);
        moves.push([colorKey, v, ms]);
        const ev = parseCommentEval(comment, moves.length);
        if (ev) analysis.push(ev);
      }
    }

    const resUp = String(result).trim().toUpperCase();
    const winnerSeat = resUp.startsWith("B+") ? "A" : resUp.startsWith("W+") ? "B" : resUp === "0" || resUp === "DRAW" ? null : undefined;

    const rec = {
      index: startIndex + records.length,
      blackSeat: "A",
      labels: { A: pb, B: pw },
      size,
      komi,
      koRule: "positional",
      moves,
      result,
      winnerSeat,
      void: false,
      reason: root.GC?.[0] || "imported SGF",
      startedAt: date,
      durationMs: moves.reduce((acc, m) => acc + (m[2] || 0), 0),
      thinkMs: { A: 0, B: 0 },
      moveCount: { A: 0, B: 0 },
      imported: true,
    };
    if (analysis.length) rec.analysis = analysis;
    records.push(rec);
  }
  return records;
}

export function parseSgf(text, index = 0) {
  return parseSgfCollection(text, index)[0];
}

export function recordToSgf(rec) {
  const board = new Board(rec.size, "simple"); // only used for coordinate conversion
  const black = rec.labels?.[rec.blackSeat] ?? rec.blackSeat;
  const whiteSeat = rec.blackSeat === "A" ? "B" : "A";
  const white = rec.labels?.[whiteSeat] ?? whiteSeat;
  const date = (rec.startedAt ?? "").slice(0, 10);
  const ruleTag = rec.rulePreset === "japanese" ? "Japanese" : "Chinese";
  let head =
    `(;GM[1]FF[4]CA[UTF-8]AP[go-arena]SZ[${rec.size}]KM[${rec.komi}]RU[${ruleTag}]` +
    (rec.handicap >= 2 ? `HA[${rec.handicap}]` : "") +
    `PB[${escape(black)}]PW[${escape(white)}]RE[${escape(rec.result)}]`;
  if (date) head += `DT[${date}]`;
  head += `GN[Game ${rec.index + 1}]GC[${escape(`ko rule: ${rec.koRule}; ${rec.reason}`)}]`;

  const evalMap = new Map();
  if (Array.isArray(rec.analysis)) {
    for (const item of rec.analysis) {
      if (item && Number.isInteger(item.moveNo) && typeof item.winrate === "number") {
        evalMap.set(item.moveNo, item);
      }
    }
  }

  const nodes = rec.moves.map(([c, v, ms], idx) => {
    const color = colorFromLetter(c) === BLACK ? "B" : "W";
    const coord = v.toLowerCase() === "pass" ? "" : board.toSgf(board.fromGtp(v));
    const parts = [`${(ms / 1000).toFixed(1)}s`];
    const ev = evalMap.get(idx + 1);
    if (ev) {
      parts.push(`B ${(ev.winrate * 100).toFixed(1)}%`);
      if (typeof ev.scoreLead === "number") {
        parts.push(ev.scoreLead >= 0 ? `B+${ev.scoreLead.toFixed(1)}` : `W+${(-ev.scoreLead).toFixed(1)}`);
      }
    }
    return `;${color}[${coord}]C[${escape(parts.join(" | "))}]`;
  });

  const lines = [];
  let line = head;
  for (const node of nodes) {
    if (line.length + node.length > 78) {
      lines.push(line);
      line = node;
    } else line += node;
  }
  lines.push(line + ")");
  return lines.join("\n") + "\n";
}

export function recordsToSgfCollection(records) {
  return records.filter((r) => !r.void).map(recordToSgf).join("\n");
}

export function recordsToCsv(records) {
  const cols = ["game", "black", "white", "result", "winner_seat", "reason", "moves", "duration_s", "avg_ms_A", "avg_ms_B", "void"];
  const rows = [cols.join(",")];
  for (const r of records) {
    const whiteSeat = r.blackSeat === "A" ? "B" : "A";
    const cells = [
      r.index + 1,
      r.labels?.[r.blackSeat] ?? r.blackSeat,
      r.labels?.[whiteSeat] ?? whiteSeat,
      r.result,
      r.winnerSeat ?? (r.void ? "" : "draw"),
      r.reason,
      r.moves.length,
      ((r.durationMs ?? 0) / 1000).toFixed(1),
      r.moveCount?.A ? Math.round(r.thinkMs.A / r.moveCount.A) : "",
      r.moveCount?.B ? Math.round(r.thinkMs.B / r.moveCount.B) : "",
      r.void ? 1 : 0,
    ];
    rows.push(cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","));
  }
  return rows.join("\n") + "\n";
}
