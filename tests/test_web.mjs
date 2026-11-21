import test from "node:test";
import assert from "node:assert/strict";

import { BLACK, WHITE, PASS, Board, GameState, IllegalMove, formatScore } from "../web/js/go.js";
import { wilson, eloFromScore, los, summarize } from "../web/js/stats.js";
import { recordToSgf, recordsToCsv, parseSgf, parseSgfCollection } from "../web/js/sgf.js";
import { readFileSync } from "node:fs";
import { MatchRunner, parseScore } from "../web/js/match.js";
import { DICT, detectLang, translate } from "../web/js/i18n.js";
import { EnginePlayer, engineLabel } from "../web/js/players.js";
import { DEFAULT_ICE, parseIceServers, encodeIceParam, decodeIceParam } from "../web/js/net.js";
import { detectBlunders, formatScoreLead, stripForRecord } from "../web/js/analysis.js";
import { computeScoreCeiling } from "../web/js/chart.js";
import { SoundEffects } from "../web/js/audio.js";

test("GTP coordinates skip I and round-trip", () => {
  const b = new Board(19);
  const p = b.fromGtp("J10");
  assert.equal(b.toGtp(p), "J10");
  assert.equal(b.toSgf(p), "ij");
  assert.throws(() => b.fromGtp("I10"), IllegalMove);
  assert.throws(() => b.fromGtp("T20"), IllegalMove);
  assert.equal(b.fromGtp("pass"), PASS);
});

test("captures, suicide, simple ko and positional superko", () => {
  const b = new Board(5, "simple");
  b.play(BLACK, b.fromGtp("B1"));
  b.play(BLACK, b.fromGtp("A2"));
  assert.throws(() => b.play(WHITE, b.fromGtp("A1")), IllegalMove); // suicide

  // Simple ko: Black surrounds B4 except C4; White surrounds C4 except B4.
  const ko = new Board(5, "simple");
  for (const v of ["B5", "A4", "B3"]) ko.play(BLACK, ko.fromGtp(v));
  for (const v of ["C5", "D4", "C3"]) ko.play(WHITE, ko.fromGtp(v));
  ko.play(WHITE, ko.fromGtp("B4"));
  assert.equal(ko.play(BLACK, ko.fromGtp("C4")), 1);
  assert.throws(() => ko.play(WHITE, ko.fromGtp("B4")), IllegalMove);
  // After an external ko threat, simple ko allows retaking.
  ko.play(WHITE, ko.fromGtp("E5"));
  ko.play(BLACK, ko.fromGtp("E4"));
  assert.equal(ko.play(WHITE, ko.fromGtp("B4")), 1);

  // Positional superko: playing a move that repeats the exact starting empty board (snapback/2-stone loop or immediate self-capture repetition).
  // Here a single stone at A1 captured by White on a 3x3 would not repeat empty because White's stone remains,
  // unless Black captures two White stones, wait: simpler — test a 2-point ko with positional superko where passing doesn't clear board hash!
  // On a board with ko at B4/C4: Black captures at C4, White plays E5, Black passes, White retakes B4 -> wait, E5 changed board!
  // Test positional superko directly via a 2-stone under-the-stones / sending-two-returning-one cycle:
  // Actually easiest board-repeat: A1 empty, Black plays A1? No, capturing 1 stone back without passing is already simple ko.
  // Positional superko differs when a third stone isn't placed (e.g., B passes, W doesn't pass? No, W retaking B4 after B passes WOULD restore the prior board!).
  const sk = new Board(5, "positional");
  for (const v of ["B5", "A4", "B3"]) sk.play(BLACK, sk.fromGtp(v));
  for (const v of ["C5", "D4", "C3"]) sk.play(WHITE, sk.fromGtp(v));
  sk.play(WHITE, sk.fromGtp("B4"));
  assert.equal(sk.play(BLACK, sk.fromGtp("C4")), 1);
  // White plays pass? No, if White passes, Black's ko_point clears; if White plays B4 next turn? No, White plays pass, Black plays pass? Then game ends.
  // Instead: White plays E1 (1), Black plays D1 (2), White plays B4 -> wait, E1 and D1 are on board.
  // Real superko without ko_point: Black at B1, A2; White at C1, B2, A3. Empty A1.
  // Wait: White plays A1 capturing nothing? No, A1 is suicide.
  // What if White has stone at A1, Black at B1, White captures? No: Black plays A1, White captures at B1 (if B1 wasn't there).
  // Simplest positional superko test: Black plays C4 (captures B4, ko_point=B4), White passes (ko_point=null), Black passes (toMove=White),
  // now White tries B4 -> simple ko allows it (ko_point is null), positional superko rejects it because the position repeats!
  sk.play(WHITE, PASS);
  sk.play(BLACK, PASS);
  assert.throws(() => sk.play(WHITE, sk.fromGtp("B4")), IllegalMove);
});

test("Tromp-Taylor area scoring", () => {
  const s = new Board(3, "positional");
  s.play(BLACK, s.fromGtp("B3"));
  s.play(BLACK, s.fromGtp("B2"));
  s.play(BLACK, s.fromGtp("B1"));
  s.play(WHITE, s.fromGtp("C2"));
  // Column A (3 empty) borders only Black; C3 and C1 border both Black and White (dame).
  const area = s.areaScore();
  assert.equal(area.black, 6);
  assert.equal(area.white, 1);
  assert.equal(formatScore(3.5), "B+3.5");
  assert.equal(formatScore(-2.5), "W+2.5");
});

test("stats calculations and SGF/CSV export", () => {
  assert.equal(Math.round(eloFromScore(0.5)), 0);
  assert.ok(eloFromScore(0.75) > 190 && eloFromScore(0.75) < 192);
  const [lo, hi] = wilson(0.5, 100);
  assert.ok(lo < 0.5 && hi > 0.5);
  assert.ok(los(8, 2) > 0.95);

  const recs = [
    {
      index: 0,
      blackSeat: "A",
      labels: { A: "Alpha", B: "Beta" },
      size: 5,
      komi: 2.5,
      koRule: "positional",
      moves: [["B", "C3", 120], ["W", "pass", 80], ["B", "pass", 50]],
      result: "B+22.5",
      winnerSeat: "A",
      void: false,
      reason: "both passed",
      startedAt: "2026-11-20T00:00:00Z",
      durationMs: 250,
      thinkMs: { A: 170, B: 80 },
      moveCount: { A: 2, B: 1 },
    },
    {
      index: 1,
      blackSeat: "B",
      labels: { A: "Alpha", B: "Beta" },
      size: 5,
      komi: 2.5,
      koRule: "positional",
      moves: [["B", "C3", 100]],
      result: "W+R",
      winnerSeat: "A",
      void: false,
      reason: "Beta resigned",
      startedAt: "2026-11-20T00:01:00Z",
      durationMs: 100,
      thinkMs: { A: 0, B: 100 },
      moveCount: { A: 0, B: 1 },
    },
  ];
  const s = summarize(recs);
  assert.equal(s.games, 2);
  assert.equal(s.aWins, 2);
  assert.equal(s.bWins, 0);
  assert.equal(s.aAsBlack.w, 1);
  assert.equal(s.aAsWhite.w, 1);

  const sgf = recordToSgf(recs[0]);
  assert.ok(sgf.includes("SZ[5]KM[2.5]"));
  assert.ok(sgf.includes(";B[cc]"));
  assert.ok(sgf.includes(";W[]"));
  const csv = recordsToCsv(recs);
  assert.ok(csv.includes("B+22.5"));
  assert.equal(parseScore("B+7.5"), 7.5);
  assert.equal(parseScore("W+0.5"), -0.5);
  assert.equal(parseScore("W+R"), null);
});

test("MatchRunner alternates colors and handles wins, resigns, illegal moves", async () => {
  const scriptPlayer = (label, movesByGame) => {
    let calls = 0;
    return {
      kind: "engine",
      label,
      requestMove(ctx) {
        const list = movesByGame[ctx.moves.length] ?? "pass";
        calls++;
        return Promise.resolve(typeof list === "function" ? list(ctx, calls) : list);
      },
      cancel() {},
    };
  };

  const a = scriptPlayer("BotA", {
    0: "C3",
    1: "resign", // when A is White on game 2
    2: "pass",
  });
  const b = scriptPlayer("BotB", {
    0: "C3",
    1: "pass",
    2: "pass",
  });

  const runner = new MatchRunner(
    { size: 5, komi: 2.5, koRule: "positional", games: 2, alternate: true, timePerMove: 0 },
    { A: a, B: b },
  );
  await runner.run();
  assert.equal(runner.records.length, 2);
  assert.equal(runner.records[0].blackSeat, "A");
  assert.equal(runner.records[0].result, "B+22.5");
  assert.equal(runner.records[0].winnerSeat, "A");
  assert.equal(runner.records[1].blackSeat, "B");
  assert.equal(runner.records[1].result, "B+R");
  assert.equal(runner.records[1].winnerSeat, "B");
});

test("i18n dictionary covers all HTML keys in both en and zh", () => {
  const enKeys = Object.keys(DICT.en);
  const zhKeys = Object.keys(DICT.zh);
  assert.deepEqual(zhKeys.sort(), enKeys.sort());

  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  for (const m of html.matchAll(/data-i18n(?:-(?:html|placeholder|title))?="([^"]+)"/g)) {
    const key = m[1];
    assert.ok(key in DICT.en, `missing en key for HTML attribute: ${key}`);
    assert.ok(key in DICT.zh, `missing zh key for HTML attribute: ${key}`);
  }

  assert.equal(detectLang({ getItem: () => "zh" }, { language: "en-US" }), "zh");
  assert.equal(detectLang({ getItem: () => null }, { language: "zh-CN" }), "zh");
  assert.equal(detectLang({ getItem: () => null }, { language: "en-US" }), "en");
  assert.ok(translate("zh", "captures", { n: 3 }).includes("3"));
});

test("engine labels combine engine name and version", () => {
  const info = { name: "Claude's GodHand", version: "v0.5.5" };
  assert.equal(engineLabel(info), "Claude's GodHand v0.5.5");
  const player = new EnginePlayer({ info }, "Host");
  assert.equal(player.label, "Host (Claude's GodHand v0.5.5)");
  assert.equal(new EnginePlayer({ info }).label, "Claude's GodHand v0.5.5");
});

test("DEFAULT_ICE omits dead PeerJS TURN domains and ICE link params round-trip", () => {
  const flatUrls = DEFAULT_ICE.flatMap((e) => (Array.isArray(e.urls) ? e.urls : [e.urls]));
  assert.ok(flatUrls.some((u) => u.includes("stun.miwifi.com")));
  assert.ok(flatUrls.some((u) => u.includes("stun.chat.bilibili.com")));
  assert.ok(!flatUrls.some((u) => u.includes("turn.peerjs.com")));

  assert.equal(parseIceServers("   "), null);
  assert.throws(() => parseIceServers("{}"));
  assert.throws(() => parseIceServers('[{"username":"a"}]'));

  const sample = '[\n  { "urls": "turn:relay.example.com:443?transport=tcp", "username": "u", "credential": "p" }\n]';
  const encoded = encodeIceParam(sample);
  assert.ok(!encoded.includes("\n"));
  const decoded = decodeIceParam(encoded);
  assert.deepEqual(JSON.parse(decoded), [{ urls: "turn:relay.example.com:443?transport=tcp", username: "u", credential: "p" }]);
});

test("analysis blunder detection, formatting, record stripping, and SGF eval comments", () => {
  const moves = [["B", "D4", 200], ["W", "Q16", 300], ["B", "C10", 400], ["W", "Q4", 250]];
  const series = [
    { moveNo: 1, winrate: 0.52, scoreLead: 0.4 },
    { moveNo: 2, winrate: 0.51, scoreLead: 0.2 },
    // Black move #3 blunders: winrate drops from 0.51 -> 0.34 (-17%), scoreLead drops 0.2 -> -4.5 (-4.7 pts)
    { moveNo: 3, winrate: 0.34, scoreLead: -4.5 },
    // White move #4 blunders back: Black winrate jumps 0.34 -> 0.55 (White lost 21%)
    { moveNo: 4, winrate: 0.55, scoreLead: 1.0 },
  ];
  const blunders = detectBlunders(series, moves);
  assert.equal(blunders.length, 2);
  assert.equal(blunders[0].moveNo, 3);
  assert.equal(blunders[0].color, "B");
  assert.ok(blunders[0].winrateDrop >= 0.16);
  assert.equal(blunders[1].moveNo, 4);
  assert.equal(blunders[1].color, "W");

  assert.equal(formatScoreLead(2.34), "B+2.3");
  assert.equal(formatScoreLead(-1.8), "W+1.8");
  assert.equal(formatScoreLead(0.02), "Even");

  const stripped = stripForRecord({
    moveNo: 3,
    winrate: 0.34,
    scoreLead: -4.5,
    visits: 200,
    ownership: new Array(361).fill(0.5),
    moves: [{ move: "D16", visits: 120, winrate: 0.51, scoreLead: 0.2, pv: ["D16", "Q4"] }],
  });
  assert.equal("ownership" in stripped, false);
  assert.equal(stripped.moves.length, 1);

  assert.equal(computeScoreCeiling([{ scoreLead: 4.5 }, { scoreLead: -12.2 }]), 15);
  assert.equal(computeScoreCeiling([{ scoreLead: 0 }]), 10);

  // SGF includes eval annotations when analysis is present on record
  const sgf = recordToSgf({
    index: 0,
    blackSeat: "A",
    labels: { A: "A", B: "B" },
    size: 5,
    komi: 2.5,
    koRule: "positional",
    moves: [["B", "C3", 100]],
    analysis: [{ moveNo: 1, winrate: 0.612, scoreLead: 1.5 }],
    result: "B+R",
    reason: "resign",
  });
  assert.ok(sgf.includes("B 61.2%"));
  assert.ok(sgf.includes("B+1.5"));

  // SoundEffects degrades gracefully in headless Node without AudioContext
  const mem = new Map();
  const sfx = new SoundEffects({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) });
  assert.equal(sfx.enabled, true);
  sfx.playStone(2);
  sfx.playPass();
  sfx.playGameEnd();
  sfx.setEnabled(false);
  assert.equal(sfx.enabled, false);
  assert.equal(mem.get("go-arena.sound"), "0");
});

test("SGF import parses single/collection games, setup stones, variations, and eval comments", () => {
  const sample = `
    (;GM[1]FF[4]SZ[9]KM[6.5]PB[Alice]PW[Bob]RE[B+3.5]DT[2026-11-22]
     AB[cc][gg]
     ;W[ee]C[1.5s | B 54.2% | B+0.8]
     (;B[ce]C[0.9s | B 61.0% | B+2.1];W[])
     (;B[ge];W[cg]))
    (;GM[1]FF[4]SZ[5]KM[2.5]PB[Bot1]PW[Bot2]RE[W+R];B[cc];W[bb])
  `;
  const recs = parseSgfCollection(sample, 0);
  assert.equal(recs.length, 2);

  const g1 = recs[0];
  assert.equal(g1.size, 9);
  assert.equal(g1.komi, 6.5);
  assert.equal(g1.labels.A, "Alice");
  assert.equal(g1.labels.B, "Bob");
  assert.equal(g1.result, "B+3.5");
  assert.equal(g1.winnerSeat, "A");
  // AB[cc][gg] + W[ee] + main branch B[ce] + W[] (pass); side branch ignored
  assert.deepEqual(g1.moves.map(([c, v]) => `${c}:${v}`), ["B:C7", "B:G3", "W:E5", "B:C5", "W:pass"]);
  assert.equal(g1.analysis.length, 2);
  assert.equal(g1.analysis[0].moveNo, 3);
  assert.ok(Math.abs(g1.analysis[0].winrate - 0.542) < 1e-4);
  assert.equal(g1.analysis[1].scoreLead, 2.1);

  // Round-trip exported SGF through parseSgf
  const exported = recordToSgf(recs[1]);
  const reparsed = parseSgf(exported);
  assert.equal(reparsed.size, 5);
  assert.equal(reparsed.moves.length, 2);
  assert.deepEqual(reparsed.moves.map(([c, v]) => [c, v]), [["B", "C3"], ["W", "B4"]]);
});

test("areaScore with dead stones, MatchRunner resume from prefix, undo, and dead-stone confirm", async () => {
  // Dead-stone scoring: Black surrounds board except one White dead stone at C2
  const b = new Board(3, "positional");
  for (const v of ["B3", "B2", "B1"]) b.play(BLACK, b.fromGtp(v));
  b.play(WHITE, b.fromGtp("C2"));
  const aliveScore = b.areaScore();
  assert.equal(aliveScore.black, 6);
  assert.equal(aliveScore.white, 1);
  // Marking C2 as dead gives Black the entire 3x3 board (9 points)
  const deadScore = b.areaScore(new Set([b.fromGtp("C2")]));
  assert.equal(deadScore.black, 9);
  assert.equal(deadScore.white, 0);

  // MatchRunner: resume from prefix + undo + human dead-stone confirmation
  let aStep = 0;
  let runnerRef = null;
  const humanA = {
    kind: "human",
    label: "HumanA",
    requestMove(ctx) {
      aStep++;
      // On second turn (after B played C2), undo 2 moves once, then pass to enter dead-stone scoring
      if (aStep === 2) {
        return new Promise((resolve) => {
          setTimeout(() => runnerRef.requestUndo(2), 5);
          // Will be interrupted by UndoSignal
          void resolve;
        });
      }
      if (aStep === 1) return Promise.resolve("B1");
      return Promise.resolve("pass");
    },
    cancel() {},
  };
  const botB = {
    kind: "engine",
    label: "BotB",
    requestMove(ctx) {
      // If A passed, pass back; otherwise play C2
      const last = ctx.moves[ctx.moves.length - 1]?.[1];
      if (last === "pass") return Promise.resolve("pass");
      return Promise.resolve("C2");
    },
    cancel() {},
  };

  let confirmCalled = false;
  const runner = new MatchRunner(
    {
      size: 3,
      komi: 0.5,
      koRule: "positional",
      games: 1,
      timePerMove: 0,
      initialMoves: [["B", "B3"], ["W", "C3"], ["B", "B2"], ["W", "pass"]],
    },
    { A: humanA, B: botB },
    {
      scoreConfirm: async (game) => {
        confirmCalled = true;
        // Mark White's C3 as dead
        return new Set([game.board.fromGtp("C3")]);
      },
    },
  );
  runnerRef = runner;
  await runner.run();
  assert.equal(confirmCalled, true);
  assert.equal(runner.records.length, 1);
  // All 9 points belong to Black minus 0.5 komi = B+8.5
  assert.equal(runner.records[0].result, "B+8.5");
  assert.equal(runner.records[0].winnerSeat, "A");
});
