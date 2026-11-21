// SGF export for finished game records.
import { BLACK, Board, colorFromLetter } from "./go.js";

const escape = (text) => String(text ?? "").replace(/\\/g, "\\\\").replace(/]/g, "\\]");

export function recordToSgf(rec) {
  const board = new Board(rec.size, "simple"); // only used for coordinate conversion
  const black = rec.labels?.[rec.blackSeat] ?? rec.blackSeat;
  const whiteSeat = rec.blackSeat === "A" ? "B" : "A";
  const white = rec.labels?.[whiteSeat] ?? whiteSeat;
  const date = (rec.startedAt ?? "").slice(0, 10);
  let head =
    `(;GM[1]FF[4]CA[UTF-8]AP[go-arena]SZ[${rec.size}]KM[${rec.komi}]RU[Chinese]` +
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
