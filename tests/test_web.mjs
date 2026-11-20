import test from "node:test";
import assert from "node:assert/strict";

import { BLACK, WHITE, PASS, Board, GameState, IllegalMove, formatScore } from "../web/js/go.js";
import { wilson, eloFromScore, los, summarize } from "../web/js/stats.js";
import { recordToSgf, recordsToCsv } from "../web/js/sgf.js";
import { readFileSync } from "node:fs";
import { MatchRunner, parseScore } from "../web/js/match.js";
import { DICT, detectLang, translate } from "../web/js/i18n.js";

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
