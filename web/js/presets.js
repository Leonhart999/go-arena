// Opening book utilities (parse SGF collections or line-based move lists, plus built-in 19x19/9x9 books)
// and engine bridge preset storage helpers.

import { parseSgfCollection } from "./sgf.js";

export const PRESETS_KEY = "go-arena.bridgePresets";

// Built-in diverse opening sequences for multi-game AI evaluation matches.
export const BUILTIN_OPENINGS = {
  19: [
    [["B", "Q16"], ["W", "D4"], ["B", "Q4"], ["W", "D16"]],
    [["B", "Q16"], ["W", "D16"], ["B", "Q4"], ["W", "D4"]],
    [["B", "Q16"], ["W", "D4"], ["B", "R3"], ["W", "C17"]],
    [["B", "R16"], ["W", "D4"], ["B", "Q3"], ["W", "C16"]],
    [["B", "Q16"], ["W", "D4"], ["B", "Q3"], ["W", "D17"]],
    [["B", "Q16"], ["W", "D4"], ["B", "D16"], ["W", "Q4"]],
  ],
  13: [
    [["B", "K10"], ["W", "D4"], ["B", "K4"], ["W", "D10"]],
    [["B", "K10"], ["W", "D10"], ["B", "K4"], ["W", "D4"]],
    [["B", "K10"], ["W", "D4"], ["B", "J3"], ["W", "D10"]],
    [["B", "K10"], ["W", "D4"], ["B", "C10"], ["W", "K4"]],
  ],
  9: [
    [["B", "E5"], ["W", "C5"], ["B", "E7"], ["W", "G5"]],
    [["B", "F5"], ["W", "D5"], ["B", "E3"], ["W", "E7"]],
    [["B", "E5"], ["W", "G7"], ["B", "C3"], ["W", "C7"]],
    [["B", "D6"], ["W", "F4"], ["B", "F6"], ["W", "D4"]],
  ],
};

// Parse an opening book from either an SGF collection or plain text (one opening per line, e.g. "Q16 D4 Q4 D16").
export function parseOpeningBook(text, boardSize = 19, maxPlies = 12) {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  if (raw.includes("(;")) {
    const recs = parseSgfCollection(raw, 0);
    const out = [];
    for (const r of recs) {
      if (r.size !== boardSize) continue;
      const seq = r.moves.slice(0, maxPlies).map(([c, v]) => [c, v]);
      if (seq.length) out.push(seq);
    }
    return out;
  }
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const clean = line.replace(/#.*/, "").trim();
    if (!clean) continue;
    const tokens = clean.split(/[\s,;]+/).filter(Boolean);
    const seq = [];
    let color = "B";
    for (const tok of tokens) {
      if (seq.length >= maxPlies) break;
      const m = /^([BW]):(.+)$/i.exec(tok);
      if (m) {
        seq.push([m[1].toUpperCase(), m[2].toUpperCase()]);
        color = m[1].toUpperCase() === "B" ? "W" : "B";
      } else {
        seq.push([color, tok.toUpperCase()]);
        color = color === "B" ? "W" : "B";
      }
    }
    if (seq.length) out.push(seq);
  }
  return out;
}

export function loadBridgePresets(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p) => p && typeof p.name === "string" && typeof p.url === "string")
      .map((p) => ({ name: p.name.trim(), url: p.url.trim() }))
      .filter((p) => p.name && p.url);
  } catch {
    return [];
  }
}

export function saveBridgePresets(list, storage = globalThis.localStorage) {
  try {
    storage?.setItem(PRESETS_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}
