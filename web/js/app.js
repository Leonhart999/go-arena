// go-arena page controller: wires players, the room, the match runner and the UI.
import { BoardView } from "./board.js";
import { GameState, Board, colorFromLetter, colorLetter, formatScore } from "./go.js";
import { BridgeClient, EnginePlayer, HumanPlayer, RemotePlayer, Cancelled, engineLabel } from "./players.js";
import { MatchRunner } from "./match.js";
import { HostRoom, GuestRoom, normalizeCode, parseIceServers, encodeIceParam, decodeIceParam } from "./net.js";
import { summarize, formatElo } from "./stats.js";
import { recordToSgf, recordsToSgfCollection, recordsToCsv, parseSgfCollection } from "./sgf.js";
import { LANG_KEY, applyDomTranslations, detectLang, translate } from "./i18n.js";
import { AnalysisManager, detectBlunders, formatScoreLead, stripForRecord } from "./analysis.js";
import { AnalysisChart } from "./chart.js";
import { SoundEffects } from "./audio.js";

const $ = (id) => document.getElementById(id);
const STORE = "go-arena.";
const THEME_KEY = "go-arena.theme";
const PEER_TIMEOUT_MS = 20000;

function detectTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // ignore
  }
  return "light";
}

const app = {
  lang: detectLang(),
  theme: detectTheme(),
  tab: "setup",
  numberMode: "last", // "last" | "last5" | "all"
  showTerritory: false,
  showCandidates: false,
  sound: new SoundEffects(),
  analyzer: new AnalysisManager(),
  analysisBusy: false,
  fullEval: null, // { abort: bool, cur: number, total: number, key: string }
  liveAnalysis: new Map(), // gameKey -> Map<moveNo, entry>
  role: "host", // "host" (also when no room is open) or "guest"
  myBridge: null,
  bBridge: null,
  refBridge: null,
  bridgeHintState: {}, // which -> { key, vars, kind, raw }
  myHuman: new HumanPlayer(),
  bHuman: new HumanPlayer("Local"),
  room: null,
  remote: null, // host: { conn, player } of the guest in seat B
  peers: new Map(), // host: conn -> { label, kind, want, role, lastSeen }
  runner: null,
  deadScoring: null, // { game, dead: Set<number>, resolve } when human players mark dead stones
  records: [],
  view: null, // guest: latest state from the host
  viewAt: 0,
  lastSoundMoveKey: "",
  review: null, // { rec, moveNo, tryMode, variation: [[c, v, ms]], varEval: entry|null, playTimer }
  guestReq: null, // guest: { req, player } being answered
  mySeat: null,
  pingTimer: null,
  replay: { key: "", game: null },
};

const t = (key, vars) => translate(app.lang, key, vars);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function log(text) {
  const pre = $("log");
  const time = new Date().toLocaleTimeString();
  pre.textContent = `${time}  ${text}\n${pre.textContent}`.slice(0, 20000);
}

function setHint(id, text, kind = "") {
  const node = $(id);
  node.textContent = text;
  node.className = `hint ${kind}`;
}

function download(filename, text, mime = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function restoreInputs() {
  for (const node of document.querySelectorAll("[data-persist]")) {
    const v = localStorage.getItem(`${STORE}ui.${node.id}`);
    if (v === null) continue;
    if (node.type === "checkbox") node.checked = v === "1";
    else node.value = v;
  }
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!t.matches?.("[data-persist]")) return;
    localStorage.setItem(`${STORE}ui.${t.id}`, t.type === "checkbox" ? (t.checked ? "1" : "0") : t.value);
  });
}

function saveRecords() {
  if (app.role !== "host") return;
  try {
    localStorage.setItem(`${STORE}records`, JSON.stringify(app.records));
  } catch {
    log(t("logSaveFail"));
  }
}

function loadRecords() {
  try {
    return JSON.parse(localStorage.getItem(`${STORE}records`) || "[]");
  } catch {
    return [];
  }
}

function readConfig() {
  const num = (id, def, min, max) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
  };
  return {
    size: Number($("cfg-size").value) || 19,
    komi: num("cfg-komi", 7.5, -150, 150),
    koRule: $("cfg-ko").value,
    games: Math.round(num("cfg-games", 10, 1, 1000)),
    alternate: $("cfg-alternate").checked,
    timePerMove: num("cfg-time", 10, 0, 3600),
    maxMoves: Math.round(num("cfg-maxmoves", 0, 0, 5000)),
    moveDelay: Math.round(num("cfg-delay", 0, 0, 60000)),
  };
}

function netSettings() {
  return {
    signalUrl: $("net-signal").value.trim(),
    iceServers: parseIceServers($("net-ice").value),
  };
}

function setRoomIdleHint(text = "", kind = "") {
  const node = $("room-idle-status");
  if (!node) return;
  node.hidden = !text;
  node.textContent = text;
  node.className = `hint ${kind}`;
}

// ---------------------------------------------------------------------------
// Players and seats
// ---------------------------------------------------------------------------
function myName() {
  return $("my-name").value.trim() || (app.role === "guest" ? t("guestDefault") : t("hostDefault"));
}

function myLabel() {
  if ($("my-kind").value === "human") return `${myName()} (${t("humanSuffix")})`;
  const info = app.myBridge?.info;
  return info ? `${myName()} (${engineLabel(info)})` : `${myName()} (${t("noEngineSuffix")})`;
}

function myPlayer() {
  if ($("my-kind").value === "human") {
    app.myHuman.owner = myName();
    return app.myHuman;
  }
  return app.myBridge?.info ? new EnginePlayer(app.myBridge, myName()) : null;
}

function seatBPlayer() {
  switch ($("b-kind").value) {
    case "remote":
      return app.remote?.player ?? null;
    case "engine":
      return app.bBridge?.info ? new EnginePlayer(app.bBridge, t("localBName")) : null;
    default:
      app.bHuman.owner = t("localBName");
      return app.bHuman;
  }
}

function seatBLabel() {
  switch ($("b-kind").value) {
    case "remote":
      return app.remote?.player.label ?? t("waitingGuestLabel");
    case "engine":
      return app.bBridge?.info ? `${t("localBName")} (${engineLabel(app.bBridge.info)})` : t("engineBNotConn");
    default:
      app.bHuman.owner = t("localBName");
      return `${t("localBName")} (${t("humanSuffix")})`;
  }
}

function activeHuman() {
  return [app.myHuman, app.bHuman].find((h) => h.pendingCtx) ?? null;
}

// Re-seat players in a running match (after a bridge reconnect or a new guest).
function onSeatsChanged() {
  if (app.role === "guest") sendHello();
  if (app.runner?.running) {
    const a = myPlayer();
    const b = seatBPlayer();
    if (a) app.runner.setSeat("A", a);
    if (b) app.runner.setSeat("B", b);
  }
  update();
}

const BRIDGES = {
  my: { url: "my-url", status: "my-status", key: "myBridge" },
  b: { url: "b-url", status: "b-status", key: "bBridge" },
  ref: { url: "ref-url", status: "ref-status", key: "refBridge" },
};

function setBridgeHint(which, key, vars = {}, kind = "", raw = null) {
  app.bridgeHintState[which] = { key, vars, kind, raw };
  const text = raw !== null ? raw : t(key, vars);
  setHint(BRIDGES[which].status, text, kind);
}

function readAnalysisConfig() {
  const num = (id, def, min, max) => {
    const v = Number($(id)?.value);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
  };
  return {
    liveEval: !!$("cfg-live-eval")?.checked,
    shareEval: !!$("cfg-share-eval")?.checked,
    maxTimeMs: Math.round(num("cfg-eval-ms", 500, 100, 10000)),
    maxVisits: Math.round(num("cfg-eval-visits", 0, 0, 10000)),
  };
}

function refCapSuffix(info) {
  if (!info) return "";
  const canScore = info.canScore ?? !!info.commands?.includes("final_score");
  const canAnalyze = info.canAnalyze ?? !!(info.commands?.includes("kata-analyze") || info.commands?.includes("lz-analyze"));
  if (canScore && canAnalyze) return t("bridgeCapFull");
  if (canAnalyze) return t("bridgeCapAnalyze");
  if (canScore) return t("bridgeCapScore");
  return t("bridgeNoScore");
}

function refreshBridgeHints() {
  for (const which of Object.keys(BRIDGES)) {
    const st = app.bridgeHintState[which];
    if (!st) continue;
    if (st.raw !== null) setHint(BRIDGES[which].status, st.raw, st.kind);
    else if (st.key === "bridgeConnected") {
      const info = app[BRIDGES[which].key]?.info;
      const extra = which === "ref" ? refCapSuffix(info) : "";
      setHint(BRIDGES[which].status, t("bridgeConnected", { label: info ? engineLabel(info) : st.vars.label, extra }), st.kind);
    } else {
      setHint(BRIDGES[which].status, t(st.key, st.vars), st.kind);
    }
  }
}

async function connectBridge(which) {
  const spec = BRIDGES[which];
  const url = $(spec.url).value.trim();
  if (!url) return setBridgeHint(which, "bridgeEnterUrl", {}, "err");
  app[spec.key]?.close();
  app[spec.key] = null;
  if (which === "ref") app.analyzer.setBridge(null);
  const client = new BridgeClient(url);
  setBridgeHint(which, "bridgeConnecting", { url });
  try {
    await client.connect();
    setBridgeHint(which, "bridgeWaitStart");
    const info = await client.hello();
    app[spec.key] = client;
    if (which === "ref") app.analyzer.setBridge(client);
    const label = engineLabel(info);
    const extra = which === "ref" ? refCapSuffix(info) : "";
    setBridgeHint(which, "bridgeConnected", { label, extra }, "ok");
    log(t("logBridgeConnected", { url, label }));
    client.addEventListener("close", () => {
      if (app[spec.key] !== client) return;
      app[spec.key] = null;
      if (which === "ref") app.analyzer.setBridge(null);
      setBridgeHint(which, "bridgeDisconnected", {}, "err");
      log(t("logBridgeLost", { url }));
      onSeatsChanged();
    });
  } catch (e) {
    client.close();
    setBridgeHint(which, "", {}, "err", e.message);
  }
  onSeatsChanged();
}

// ---------------------------------------------------------------------------
// Live analysis & evaluation helpers
// ---------------------------------------------------------------------------
function gameKeyOf(curOrRec) {
  if (!curOrRec) return "";
  return `g${curOrRec.index}:${curOrRec.size}:${curOrRec.komi}`;
}

function getGameEvalMap(gameKey, create = false) {
  if (!gameKey) return null;
  let m = app.liveAnalysis.get(gameKey);
  if (!m && create) {
    m = new Map();
    app.liveAnalysis.set(gameKey, m);
  }
  return m || null;
}

function getAnalysisSeriesForCurrent(v) {
  if (app.review) {
    const rec = app.review.rec;
    const key = gameKeyOf(rec);
    const liveMap = getGameEvalMap(key, false);
    const merged = new Map();
    if (Array.isArray(rec.analysis)) {
      for (const item of rec.analysis) {
        if (item && Number.isInteger(item.moveNo)) merged.set(item.moveNo, item);
      }
    }
    if (liveMap) {
      for (const [k, val] of liveMap) merged.set(k, val);
    }
    return {
      key,
      moves: rec.moves,
      moveNo: app.review.moveNo,
      map: merged,
      series: [...merged.values()].sort((a, b) => a.moveNo - b.moveNo),
    };
  }
  const cur = v?.current;
  if (!cur) return { key: "", moves: [], moveNo: 0, map: new Map(), series: [] };
  const key = gameKeyOf(cur);
  const merged = new Map();
  if (Array.isArray(cur.analysis)) {
    for (const item of cur.analysis) {
      if (item && Number.isInteger(item.moveNo)) merged.set(item.moveNo, item);
    }
  }
  const liveMap = getGameEvalMap(key, false);
  if (liveMap) {
    for (const [k, val] of liveMap) merged.set(k, val);
  }
  return {
    key,
    moves: cur.moves,
    moveNo: cur.moves.length,
    map: merged,
    series: [...merged.values()].sort((a, b) => a.moveNo - b.moveNo),
  };
}

function latestEvalAt(series, moveNo) {
  if (!series.length) return null;
  let best = null;
  for (const item of series) {
    if (item.moveNo <= moveNo) best = item;
    else break;
  }
  return best;
}

// Anti-cheat / spoiler gate: hide AI candidate moves while an active player
// (human on this page, or seated remote guest) is playing a live game.
function canShowCandidates(v) {
  if (app.review) return true;
  const cur = v?.current;
  if (!cur || cur.result) return true;
  if (app.role === "guest" && app.mySeat) return false;
  if (app.role === "host") {
    const aHuman = $("my-kind").value === "human";
    const bHuman = $("b-kind").value === "human";
    if (aHuman || bHuman) return false;
  }
  return true;
}

function scheduleLiveAnalysis(cur) {
  if (app.role !== "host" || !cur || cur.result) return;
  const cfg = readAnalysisConfig();
  if (!cfg.liveEval || !app.analyzer.capable) return;
  const moveNo = cur.moves.length;
  const toPlay = moveNo % 2 === 0 ? "B" : "W";
  app.analyzer.request({
    gameKey: gameKeyOf(cur),
    moveNo,
    size: cur.size,
    komi: cur.komi,
    color: toPlay,
    moves: cur.moves,
    maxTimeMs: cfg.maxTimeMs,
    maxVisits: cfg.maxVisits,
    maxMoves: 5,
    includeOwnership: true,
  });
}

function buildReviewGame(review) {
  const { rec, moveNo, variation } = review;
  const g = new GameState(rec.size, rec.komi, rec.koRule);
  const mainSlice = rec.moves.slice(0, moveNo);
  try {
    for (const [c, mv, ms] of mainSlice) g.apply(colorFromLetter(c), mv, ms ?? 0, { allowSameColor: true });
    for (const [c, mv, ms] of variation) g.apply(colorFromLetter(c), mv, ms ?? 0);
  } catch (e) {
    console.warn("review replay failed", e);
  }
  return { g, mainSlice };
}

function triggerVariationAnalysis() {
  if (!app.review || !app.review.variation.length || !app.analyzer.capable) return;
  const cfg = readAnalysisConfig();
  const { rec, moveNo, variation } = app.review;
  const allMoves = rec.moves.slice(0, moveNo).concat(variation);
  const { g } = buildReviewGame(app.review);
  const toPlay = colorLetter(g.toPlay);
  app.analyzer.request({
    gameKey: `var:${gameKeyOf(rec)}:${moveNo}:${variation.length}`,
    moveNo: allMoves.length,
    size: rec.size,
    komi: rec.komi,
    color: toPlay,
    moves: allMoves,
    maxTimeMs: Math.max(cfg.maxTimeMs, 600),
    maxVisits: cfg.maxVisits,
    maxMoves: 5,
    includeOwnership: true,
  });
}

function triggerManualAnalysis() {
  if (!app.analyzer.capable) {
    log(t("logAnalyzeNeedBridge"));
    return;
  }
  const cfg = readAnalysisConfig();
  if (app.review) {
    if (app.review.variation.length) {
      triggerVariationAnalysis();
      return;
    }
    const { rec, moveNo } = app.review;
    const { g, mainSlice } = buildReviewGame(app.review);
    const toPlay = colorLetter(g.toPlay);
    app.analyzer.request({
      gameKey: gameKeyOf(rec),
      moveNo,
      size: rec.size,
      komi: rec.komi,
      color: toPlay,
      moves: mainSlice,
      maxTimeMs: Math.max(cfg.maxTimeMs, 800),
      maxVisits: cfg.maxVisits,
      maxMoves: 5,
      includeOwnership: true,
    });
    return;
  }
  const v = currentView();
  const cur = v?.current;
  if (!cur) return;
  const moveNo = cur.moves.length;
  const toPlay = moveNo % 2 === 0 ? "B" : "W";
  app.analyzer.request({
    gameKey: gameKeyOf(cur),
    moveNo,
    size: cur.size,
    komi: cur.komi,
    color: toPlay,
    moves: cur.moves,
    maxTimeMs: Math.max(cfg.maxTimeMs, 800),
    maxVisits: cfg.maxVisits,
    maxMoves: 5,
    includeOwnership: true,
  });
}

function stopFullAnalysis() {
  if (!app.fullEval) return;
  app.fullEval.abort = true;
  app.analyzer.cancel();
}

async function toggleFullGameAnalysis() {
  if (app.fullEval) {
    stopFullAnalysis();
    return;
  }
  if (!app.analyzer.capable) {
    log(t("logAnalyzeNeedBridge"));
    return;
  }
  const rec = app.review?.rec ?? null;
  const cur = !rec ? currentView()?.current : null;
  const target = rec || cur;
  if (!target || !target.moves?.length) return;

  const cfg = readAnalysisConfig();
  const key = gameKeyOf(target);
  const total = target.moves.length;
  const state = { abort: false, cur: 0, total, key };
  app.fullEval = state;
  app.analyzer.cancel();
  renderAnalysis(currentView());

  try {
    const existing = getGameEvalMap(key, true);
    if (rec && Array.isArray(rec.analysis)) {
      for (const item of rec.analysis) {
        if (item && Number.isInteger(item.moveNo)) existing.set(item.moveNo, item);
      }
    }
    const g = new GameState(target.size, target.komi, target.koRule || "positional");
    for (let m = 0; m <= total; m++) {
      if (state.abort || !app.analyzer.capable) break;
      state.cur = m;
      renderFullEvalBar();
      const slice = target.moves.slice(0, m);
      if (m > 0) {
        const [c, v, ms] = target.moves[m - 1];
        try {
          g.apply(colorFromLetter(c), v, ms ?? 0, { allowSameColor: true });
        } catch {
          // keep going on imported setup positions
        }
      }
      const prev = existing.get(m);
      if (prev && prev.visits >= Math.max(1, cfg.maxVisits || 1) && prev.moves?.length) {
        continue;
      }
      try {
        await app.analyzer.analyzeOnce({
          gameKey: key,
          moveNo: m,
          size: target.size,
          komi: target.komi,
          color: colorLetter(g.toPlay),
          moves: slice,
          maxTimeMs: cfg.maxTimeMs,
          maxVisits: cfg.maxVisits,
          maxMoves: 5,
          includeOwnership: m === total || (app.review?.moveNo === m),
        });
      } catch (e) {
        if (!state.abort) log(t("logAnalyzeErr", { msg: e.message }));
        break;
      }
    }
    if (state.abort) log(t("logFullEvalStopped"));
    else log(t("logFullEvalDone", { n: total }));
  } finally {
    if (app.fullEval === state) app.fullEval = null;
    update();
  }
}

function renderFullEvalBar() {
  const bar = $("full-eval-bar");
  const btn = $("btn-analyze-full");
  if (btn) {
    btn.textContent = app.fullEval ? t("btnAnalyzeStop") : t("btnAnalyzeFull");
    btn.classList.toggle("danger", !!app.fullEval);
  }
  if (!bar) return;
  bar.hidden = !app.fullEval;
  if (app.fullEval) {
    const pct = app.fullEval.total ? Math.round((app.fullEval.cur / app.fullEval.total) * 100) : 0;
    $("full-eval-text").textContent = t("fullEvalProgress", { cur: app.fullEval.cur, total: app.fullEval.total });
    $("full-eval-fill").style.width = `${pct}%`;
  }
}

// ---------------------------------------------------------------------------
// SGF import & resume from review position
// ---------------------------------------------------------------------------
function importSgfText(text) {
  let imported;
  try {
    imported = parseSgfCollection(text, app.records.length);
  } catch (e) {
    log(t("logImpSgfFail", { msg: e.message }));
    return;
  }
  for (const rec of imported) {
    rec.index = app.records.length;
    app.records.push(rec);
  }
  saveRecords();
  broadcast({ t: "records", records: app.records });
  log(t("logImpSgfOk", { n: imported.length }));
  renderResults();
  openReview(imported[imported.length - 1]);
  setTab("analysis");
}

function resumeFromReview() {
  if (app.role !== "host" || !app.review) return;
  if (app.runner?.running) {
    log(t("logResumeStopFirst"));
    return;
  }
  const { rec, moveNo, variation } = app.review;
  const prefix = rec.moves.slice(0, moveNo).concat(variation).map(([c, v]) => [c, v]);
  // Sync board size & komi inputs to match the resumed game
  if (["19", "13", "9"].includes(String(rec.size))) {
    $("cfg-size").value = String(rec.size);
  }
  $("cfg-komi").value = String(rec.komi);
  stopReviewPlay();
  app.review = null;
  $("review-bar").hidden = true;
  log(t("logResumeStart", { moveNo: prefix.length }));
  startMatch({
    initialMoves: prefix,
    size: rec.size,
    komi: rec.komi,
    koRule: rec.koRule || readConfig().koRule,
    games: 1,
    keepRecords: true,
  });
}

// ---------------------------------------------------------------------------
// Match control (host)
// ---------------------------------------------------------------------------
function startMatch(override = null) {
  if (app.runner?.running) return;
  const a = myPlayer();
  const b = seatBPlayer();
  if (!a) return log(t("logNeedSeatA"));
  if (!b) return log(t("logNeedSeatB"));
  const keepRecords = !!override?.keepRecords;
  if (!keepRecords && app.records.length && !confirm(t("confirmNewMatch"))) return;
  stopFullAnalysis();
  stopReviewPlay();
  const canRefScore = app.refBridge?.info && (app.refBridge.info.canScore ?? app.refBridge.info.commands?.includes("final_score"));
  const referee = canRefScore ? new EnginePlayer(app.refBridge, "referee") : null;
  const baseCfg = readConfig();
  const cfg = override
    ? {
        ...baseCfg,
        size: override.size ?? baseCfg.size,
        komi: override.komi ?? baseCfg.komi,
        koRule: override.koRule ?? baseCfg.koRule,
        games: override.games ?? baseCfg.games,
        initialMoves: override.initialMoves ?? null,
      }
    : baseCfg;

  const scoreConfirm = (game) =>
    new Promise((resolve) => {
      app.deadScoring = { game, dead: new Set(), resolve };
      update();
    });

  const runner = new MatchRunner(cfg, { A: a, B: b }, { referee, scoreConfirm });
  app.runner = runner;
  app.deadScoring = null;
  if (!keepRecords) {
    app.records = [];
    app.liveAnalysis.clear();
    app.analyzer.clearOwnership();
  }
  app.review = null;
  $("review-bar").hidden = true;
  app.analyzer.cancel();
  saveRecords();
  if (!keepRecords) broadcast({ t: "records", records: [] });
  runner.addEventListener("state", update);
  runner.addEventListener("move", (e) => {
    const d = e.detail;
    if (d) {
      if (String(d.move).toLowerCase() === "pass") app.sound.playPass();
      else app.sound.playStone(d.captured || 0);
    }
    update();
    const cur = runner.snapshot().current;
    if (cur && !cur.result) scheduleLiveAnalysis(cur);
  });
  runner.addEventListener("log", (e) => log(e.detail));
  runner.addEventListener("record", (e) => {
    const rec = e.detail;
    rec.index = app.records.length;
    const key = gameKeyOf({ index: e.detail.index, size: rec.size, komi: rec.komi });
    const evalMap = getGameEvalMap(key, false);
    if (evalMap && evalMap.size) {
      rec.analysis = [...evalMap.values()]
        .sort((x, y) => x.moveNo - y.moveNo)
        .map(stripForRecord);
    }
    app.records.push(rec);
    saveRecords();
    broadcast({ t: "record", record: rec });
    app.sound.playGameEnd();
    renderResults();
  });
  runner.addEventListener("done", () => {
    app.deadScoring = null;
    log(t("logMatchDone"));
    update();
  });
  log(t("logMatchStart", { a: a.label, b: b.label, games: runner.config.games }));
  setTab("results");
  runner.run().catch((e) => {
    log(t("logMatchError", { msg: e.message }));
    console.error(e);
  });
  update();
}

function hostView({ includeEval = false, stripCandidates = false } = {}) {
  const v = app.runner ? app.runner.snapshot() : { running: false, paused: false, config: readConfig(), current: null };
  if (!v.running) v.seats = { A: myLabel(), B: seatBLabel() };
  v.played = app.records.filter((r) => !r.void).length;
  if (includeEval && v.current) {
    const key = gameKeyOf(v.current);
    const evalMap = getGameEvalMap(key, false);
    if (evalMap && evalMap.size) {
      v.current.analysis = [...evalMap.values()]
        .sort((a, b) => a.moveNo - b.moveNo)
        .map((item) => {
          const slim = stripForRecord(item);
          if (stripCandidates) delete slim.moves;
          return slim;
        });
    }
  }
  return v;
}

function currentView() {
  if (app.role === "host") {
    app.viewAt = Date.now();
    return hostView({ includeEval: true });
  }
  return app.view;
}

// ---------------------------------------------------------------------------
// Room: host side
// ---------------------------------------------------------------------------
function broadcast(msg) {
  if (app.role === "host" && app.room) app.room.broadcast(msg);
}

function broadcastState() {
  if (app.role !== "host" || !app.room) return;
  const shareEval = readAnalysisConfig().shareEval;
  const plainView = hostView({ includeEval: false });
  const specView = shareEval ? hostView({ includeEval: true, stripCandidates: true }) : plainView;
  for (const [conn, peer] of app.peers) {
    const isSeatedPlayer = app.remote?.conn === conn || peer.role === "player";
    const viewForPeer = isSeatedPlayer ? plainView : specView;
    app.room.send(conn, { t: "state", view: viewForPeer });
  }
}

async function createRoom() {
  let settings;
  try {
    settings = netSettings();
  } catch (e) {
    setRoomIdleHint(e.message, "err");
    return setHint("room-status", e.message, "err");
  }
  setRoomIdleHint();
  const room = new HostRoom();
  room.addEventListener("diag", (e) => log(e.detail));
  $("room-create").disabled = true;
  log(t("logOpeningRoom"));
  try {
    await room.open(settings);
  } catch (e) {
    $("room-create").disabled = false;
    setRoomIdleHint(e.message, "err");
    log(t("logOpenRoomFail", { msg: e.message }));
    return;
  }
  $("room-create").disabled = false;
  app.room = room;
  room.addEventListener("join", (e) => {
    app.peers.set(e.detail, { label: "connecting ...", kind: "", want: "", role: "pending", lastSeen: Date.now() });
    renderRoom();
  });
  room.addEventListener("leave", (e) => onPeerLeft(e.detail));
  room.addEventListener("message", (e) => onHostMessage(e.detail.conn, e.detail.msg));
  room.addEventListener("error", (e) => log(t("logRoomErr", { msg: e.detail?.message ?? e.detail })));
  app.pingTimer = setInterval(() => {
    broadcast({ t: "ping" });
    for (const [conn, peer] of app.peers) {
      if (Date.now() - peer.lastSeen > PEER_TIMEOUT_MS) {
        log(t("logPeerTimeout", { label: peer.label }));
        room.drop(conn);
      }
    }
  }, 5000);
  log(t("logRoomOpen", { code: room.code }));
  update();
}

function assignSeatB() {
  if ($("b-kind").value !== "remote" || app.remote || !app.room) return;
  for (const [conn, peer] of app.peers) {
    if (peer.want !== "player") continue;
    app.remote = { conn, player: new RemotePlayer(conn, { label: peer.label, kind: peer.kind }) };
    peer.role = "player";
    app.room.send(conn, { t: "welcome", seat: "B", host: myLabel() });
    log(t("logPeerTakesB", { label: peer.label }));
    onSeatsChanged();
    return;
  }
}

function releaseSeatB(reason) {
  if (!app.remote) return;
  const { conn, player } = app.remote;
  app.remote = null;
  if (app.runner?.running) {
    app.runner.pause();
    app.runner.voidCurrent(reason);
  }
  player.disconnect();
  const peer = app.peers.get(conn);
  if (peer) {
    peer.role = "spectator";
    app.room?.send(conn, { t: "welcome", seat: null, host: myLabel() });
  }
}

function onHostMessage(conn, msg) {
  const peer = app.peers.get(conn);
  if (!peer || !msg || typeof msg !== "object") return;
  peer.lastSeen = Date.now();
  switch (msg.t) {
    case "hello": {
      peer.label = String(msg.label || "guest").slice(0, 80);
      peer.kind = msg.kind === "human" ? "human" : "engine";
      peer.want = msg.want === "player" ? "player" : "spectator";
      if (app.remote?.conn === conn) {
        if (peer.want === "player") app.remote.player.info = { label: peer.label, kind: peer.kind };
        else releaseSeatB("seat B switched to watching");
      }
      if (app.remote?.conn !== conn) {
        if (peer.role === "pending") peer.role = "spectator";
        app.room.send(conn, { t: "welcome", seat: null, host: myLabel() });
      } else {
        app.room.send(conn, { t: "welcome", seat: "B", host: myLabel() });
      }
      app.room.send(conn, { t: "records", records: app.records });
      assignSeatB();
      update();
      break;
    }
    case "move":
      if (app.remote?.conn === conn) app.remote.player.handleMove(msg);
      break;
    default:
      break;
  }
}

function onPeerLeft(conn) {
  const peer = app.peers.get(conn);
  app.peers.delete(conn);
  log(t("logPeerLeft", { label: peer?.label ?? t("guestDefault") }));
  if (app.remote?.conn === conn) {
    releaseSeatB("seat B left the room");
    assignSeatB();
  }
  update();
}

// ---------------------------------------------------------------------------
// Room: guest side
// ---------------------------------------------------------------------------
async function joinRoom() {
  const code = normalizeCode($("join-code").value);
  if (!code) {
    setRoomIdleHint(t("logEnterCode"), "err");
    return log(t("logEnterCode"));
  }
  let settings;
  try {
    settings = netSettings();
  } catch (e) {
    setRoomIdleHint(e.message, "err");
    return log(e.message);
  }
  if (app.runner?.running) {
    setRoomIdleHint(t("logStopFirst"), "err");
    return log(t("logStopFirst"));
  }
  setRoomIdleHint(t("logJoining", { code }));
  const room = new GuestRoom();
  room.addEventListener("diag", (e) => log(e.detail));
  $("room-join").disabled = true;
  log(t("logJoining", { code }));
  try {
    await room.join(settings, code);
  } catch (e) {
    $("room-join").disabled = false;
    setRoomIdleHint(e.message, "err");
    log(t("logJoinFail", { msg: e.message }));
    return;
  }
  setRoomIdleHint();
  $("room-join").disabled = false;
  app.room = room;
  app.role = "guest";
  app.view = null;
  app.review = null;
  app.records = [];
  room.addEventListener("message", (e) => onGuestMessage(e.detail));
  room.addEventListener("close", () => {
    log(t("logHostClosed"));
    leaveRoom();
  });
  sendHello();
  log(t("logJoined", { code }));
  update();
  renderResults();
}

function sendHello() {
  if (app.role !== "guest" || !app.room) return;
  app.room.send({
    t: "hello",
    want: $("join-watch").checked ? "spectator" : "player",
    label: myLabel(),
    kind: $("my-kind").value,
  });
}

function onGuestMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.t) {
    case "welcome":
      if (app.mySeat !== msg.seat) log(msg.seat ? t("logWelcomeSeatB", { host: msg.host }) : t("logWelcomeWatch", { host: msg.host }));
      app.mySeat = msg.seat;
      app.hostLabel = msg.host;
      update();
      break;
    case "state": {
      const prevCur = app.view?.current;
      const nextCur = msg.view?.current;
      app.view = msg.view;
      app.viewAt = Date.now();
      if (nextCur && nextCur.moves.length > 0) {
        const moveKey = `${nextCur.index}:${nextCur.moves.length}`;
        if (moveKey !== app.lastSoundMoveKey && (!prevCur || prevCur.index !== nextCur.index || nextCur.moves.length > prevCur.moves.length)) {
          app.lastSoundMoveKey = moveKey;
          const lastMv = nextCur.moves[nextCur.moves.length - 1]?.[1] ?? "";
          if (String(lastMv).toLowerCase() === "pass") app.sound.playPass();
          else app.sound.playStone(0);
        }
      }
      update();
      break;
    }
    case "records":
      app.records = Array.isArray(msg.records) ? msg.records : [];
      renderResults();
      break;
    case "record":
      app.records.push(msg.record);
      renderResults();
      break;
    case "genmove":
      answerGenmove(msg);
      break;
    case "cancel":
      if (app.guestReq?.req === msg.req) {
        const { player } = app.guestReq;
        app.guestReq = null;
        player.cancel();
      }
      break;
    case "ping":
      app.room?.send({ t: "pong" });
      break;
    default:
      break;
  }
}

async function answerGenmove(msg) {
  const player = myPlayer();
  if (!player) {
    app.room?.send({ t: "move", req: msg.req, error: "the guest's engine is not connected" });
    return;
  }
  app.guestReq = { req: msg.req, player };
  try {
    const move = await player.requestMove(msg);
    if (app.guestReq?.req === msg.req) app.room?.send({ t: "move", req: msg.req, move });
  } catch (e) {
    if (!(e instanceof Cancelled) && app.guestReq?.req === msg.req) app.room?.send({ t: "move", req: msg.req, error: e.message });
  } finally {
    if (app.guestReq?.req === msg.req) app.guestReq = null;
  }
}

function leaveRoom() {
  const room = app.room;
  app.room = null;
  clearInterval(app.pingTimer);
  room?.close();
  if (app.role === "guest") {
    app.role = "host";
    app.mySeat = null;
    app.view = null;
    if (app.guestReq) {
      app.guestReq.player.cancel();
      app.guestReq = null;
    }
    app.myHuman.cancel();
    app.records = loadRecords();
  } else {
    releaseSeatB("room closed");
    app.peers.clear();
  }
  log(t("logLeftRoom"));
  update();
  renderResults();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
let boardView;
let evalChart;

function replayFor(cur) {
  const key = `${cur.index}|${cur.size}|${cur.koRule}|${cur.komi}`;
  let { game } = app.replay;
  if (app.replay.key !== key || !game || game.moves.length > cur.moves.length) {
    game = new GameState(cur.size, cur.komi, cur.koRule);
    app.replay = { key, game };
  }
  try {
    for (let i = game.moves.length; i < cur.moves.length; i++) {
      const [c, v, ms] = cur.moves[i];
      game.apply(colorFromLetter(c), v, ms ?? 0, { allowSameColor: true });
    }
  } catch (e) {
    console.warn("replay failed", e);
  }
  return game;
}

function computeMoveNumbers(board, moves, variationMoves = null) {
  if (Array.isArray(variationMoves) && variationMoves.length) {
    // In variation mode, always label the variation moves 1..K so the branch stands out
    const map = new Map();
    const varPts = new Set();
    for (let i = 0; i < variationMoves.length; i++) {
      const mv = String(variationMoves[i][1] ?? "").trim();
      if (!mv || mv.toLowerCase() === "pass") continue;
      try {
        const p = board.fromGtp(mv);
        if (p >= 0 && board.stones[p] !== 0) {
          map.set(p, i + 1);
          varPts.add(p);
        }
      } catch {
        // ignore
      }
    }
    return { map, varPts };
  }
  if (app.numberMode === "last" || !moves?.length) return { map: null, varPts: null };
  const start = app.numberMode === "last5" ? Math.max(0, moves.length - 5) : 0;
  const map = new Map();
  for (let i = start; i < moves.length; i++) {
    const mv = String(moves[i][1] ?? "").trim();
    if (!mv || mv.toLowerCase() === "pass") continue;
    try {
      const p = board.fromGtp(mv);
      if (p >= 0 && board.stones[p] !== 0) map.set(p, i + 1);
    } catch {
      // ignore invalid coordinate
    }
  }
  return { map, varPts: null };
}

function renderBoard(v) {
  const evalCtx = getAnalysisSeriesForCurrent(v);
  const inVariation = !!(app.review && app.review.variation.length);
  const curEval = inVariation ? app.review.varEval : (evalCtx.map.get(evalCtx.moveNo) ?? null);
  const allowCands = app.showCandidates && canShowCandidates(v);
  const candidates = allowCands && curEval?.moves?.length ? curEval.moves : null;

  if (app.review) {
    const { rec, moveNo, variation } = app.review;
    const { g, mainSlice } = buildReviewGame(app.review);
    const varKey = inVariation ? `var:${gameKeyOf(rec)}:${moveNo}:${variation.length}` : evalCtx.key;
    const ownMoveNo = inVariation ? mainSlice.length + variation.length : moveNo;
    const aiOwn = app.showTerritory ? app.analyzer.getOwnership(varKey, ownMoveNo) : null;
    const ttOwner = app.showTerritory && !aiOwn
      ? g.trompTaylor().owner
      : !inVariation && moveNo === rec.moves.length && /Tromp-Taylor/.test(rec.reason)
        ? g.trompTaylor().owner
        : null;
    const { map, varPts } = computeMoveNumbers(g.board, mainSlice, variation);
    boardView.render({
      size: rec.size,
      stones: g.board.stones,
      lastPoint: g.lastPoint,
      owner: ttOwner,
      ownership: aiOwn,
      moveNumbers: map,
      variationPoints: varPts,
      candidates,
      toPlay: g.toPlay,
    });
    return;
  }
  const cur = v?.current;
  if (cur) {
    const g = replayFor(cur);
    if (app.deadScoring && app.deadScoring.game === app.runner?.current?.game) {
      const tt = g.trompTaylor(app.deadScoring.dead);
      boardView.render({
        size: cur.size,
        stones: g.board.stones,
        lastPoint: g.lastPoint,
        owner: tt.owner,
        deadPoints: app.deadScoring.dead,
      });
      return;
    }
    const aiOwn = app.showTerritory ? app.analyzer.getOwnership(evalCtx.key, cur.moves.length) : null;
    const ttOwner = app.showTerritory && !aiOwn
      ? g.trompTaylor().owner
      : cur.owner
        ? Uint8Array.from(cur.owner)
        : null;
    const { map } = computeMoveNumbers(g.board, cur.moves);
    boardView.render({
      size: cur.size,
      stones: g.board.stones,
      lastPoint: g.lastPoint,
      owner: ttOwner,
      ownership: aiOwn,
      moveNumbers: map,
      candidates,
      toPlay: g.toPlay,
    });
  } else {
    const size = v?.config?.size ?? (Number($("cfg-size").value) || 19);
    boardView.render({ size, stones: new Board(size, "simple").stones, lastPoint: null });
  }
}

function formatLeadLocalized(scoreLead) {
  if (typeof scoreLead !== "number" || !Number.isFinite(scoreLead)) return "";
  const base = formatScoreLead(scoreLead, {
    black: t("evalBlackShort"),
    white: t("evalWhiteShort"),
    even: t("evalEven"),
  });
  return base === t("evalEven") ? base : t("evalPts", { text: base });
}

function renderAnalysis(v) {
  const evalCtx = getAnalysisSeriesForCurrent(v);
  const inVariation = !!(app.review && app.review.variation.length);
  const latest = inVariation ? (app.review.varEval || latestEvalAt(evalCtx.series, evalCtx.moveNo)) : latestEvalAt(evalCtx.series, evalCtx.moveNo);
  const exact = inVariation ? app.review.varEval : (evalCtx.map.get(evalCtx.moveNo) ?? null);

  // Top winrate bar
  const barWrap = $("eval-bar-wrap");
  if (barWrap) {
    barWrap.hidden = !latest;
    if (latest) {
      const bPct = Math.max(0, Math.min(100, latest.winrate * 100));
      const wPct = 100 - bPct;
      $("eval-black-pct").textContent = `${t("evalBlackShort")} ${bPct.toFixed(1)}%`;
      $("eval-white-pct").textContent = `${t("evalWhiteShort")} ${wPct.toFixed(1)}%`;
      $("eval-lead").textContent = formatLeadLocalized(latest.scoreLead);
      $("eval-bar-fill").style.width = `${bPct.toFixed(1)}%`;
      const meter = barWrap.querySelector(".eval-bar");
      if (meter) meter.setAttribute("aria-valuenow", bPct.toFixed(1));
    }
  }

  // Analysis tab KPIs
  $("eval-busy-dot").hidden = !app.analysisBusy;
  $("btn-analyze-now").disabled = !app.analyzer.capable || !!app.fullEval || (!app.review && !v?.current);
  const fullBtn = $("btn-analyze-full");
  if (fullBtn) {
    const hasTarget = !!(app.review?.rec?.moves?.length || v?.current?.moves?.length);
    fullBtn.disabled = !app.fullEval && (!app.analyzer.capable || !hasTarget);
  }
  renderFullEvalBar();
  $("an-winrate").textContent = latest ? `${(latest.winrate * 100).toFixed(1)}%` : "--";
  $("an-lead").textContent = latest && typeof latest.scoreLead === "number" ? formatLeadLocalized(latest.scoreLead) : "--";
  $("an-visits").textContent = latest && latest.visits ? String(latest.visits) : "--";

  // Tromp-Taylor area estimate fallback note
  const ttNode = $("an-tt-estimate");
  if (ttNode) {
    let g = null;
    if (app.review) {
      g = buildReviewGame(app.review).g;
    } else if (v?.current) {
      g = replayFor(v.current);
    }
    if (g && g.moves.length > 0) {
      const tt = g.trompTaylor();
      ttNode.textContent = t("evalTtFallback", { b: tt.black, w: tt.white, diff: formatScore(tt.diff) });
    } else {
      ttNode.textContent = "";
    }
  }

  // Blunders + SVG chart
  const blunders = detectBlunders(evalCtx.series, evalCtx.moves);
  if (evalChart) {
    evalChart.render({
      points: evalCtx.series,
      blunders,
      totalMoves: evalCtx.moves.length,
      currentMove: evalCtx.moveNo,
      emptyText: t("evalChartEmpty"),
    });
  }

  // Top AI candidates list
  const candList = $("an-cands-list");
  if (candList) {
    candList.replaceChildren();
    const allowCands = canShowCandidates(v);
    if (!allowCands) {
      const div = document.createElement("div");
      div.className = "an-empty";
      div.textContent = t("evalCandsHidden");
      candList.appendChild(div);
    } else if (!exact?.moves?.length) {
      const div = document.createElement("div");
      div.className = "an-empty";
      div.textContent = t("evalNoCands");
      candList.appendChild(div);
    } else {
      const sideIsBlack = evalCtx.moveNo % 2 === 0;
      exact.moves.slice(0, 5).forEach((m, idx) => {
        const row = document.createElement("div");
        row.className = `an-cand-row${idx === 0 ? " best" : ""}`;
        const mv = document.createElement("span");
        mv.className = "an-cand-move";
        mv.textContent = m.move;
        const wr = document.createElement("span");
        wr.className = "an-cand-wr";
        const moverWr = sideIsBlack ? m.winrate : 1 - m.winrate;
        wr.textContent = `${(moverWr * 100).toFixed(1)}%`;
        const lead = document.createElement("span");
        lead.className = "an-cand-lead";
        lead.textContent = typeof m.scoreLead === "number" ? formatLeadLocalized(m.scoreLead) : "";
        const pv = document.createElement("span");
        pv.className = "an-cand-pv";
        pv.textContent = (m.pv || []).slice(0, 6).join(" ");
        pv.title = (m.pv || []).join(" ");
        row.append(mv, wr, lead, pv);
        row.addEventListener("mouseenter", () => boardView?._renderPv(m));
        row.addEventListener("mouseleave", () => boardView?._renderPv(null));
        candList.appendChild(row);
      });
    }
  }

  // Turning points / blunders list
  const bList = $("an-blunders-list");
  const bPill = $("an-blunder-count");
  if (bPill) {
    bPill.textContent = String(blunders.length);
    bPill.hidden = blunders.length === 0;
  }
  if (bList) {
    bList.replaceChildren();
    if (!blunders.length) {
      const div = document.createElement("div");
      div.className = "an-empty";
      div.textContent = t("evalNoBlunders");
      bList.appendChild(div);
    } else {
      const top = [...blunders]
        .sort((a, b) => Math.max(b.winrateDrop * 100, (b.scoreDrop ?? 0) * 2) - Math.max(a.winrateDrop * 100, (a.scoreDrop ?? 0) * 2))
        .slice(0, 8);
      for (const b of top) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "an-blunder-btn";
        btn.title = t("evalJumpHint");
        btn.textContent = t("evalBlunderItem", {
          moveNo: b.moveNo,
          color: b.color,
          vertex: b.vertex,
          dWr: (b.winrateDrop * 100).toFixed(1),
          dScore: b.scoreDrop !== null ? b.scoreDrop.toFixed(1) : null,
        });
        btn.onclick = () => jumpToMoveFromChart(b.moveNo);
        bList.appendChild(btn);
      }
    }
  }
}

function jumpToMoveFromChart(moveNo) {
  if (app.review) {
    stepReview(moveNo);
    return;
  }
  // If a finished game is shown or records exist, allow jumping into review of the latest finished game
  const cur = currentView()?.current;
  if (cur && cur.result) {
    const rec = app.records.find((r) => r.index === cur.index);
    if (rec) {
      openReview(rec);
      stepReview(moveNo);
    }
  }
}

function renderPlayers(v) {
  const cur = app.review ? null : v?.current;
  const rec = app.review?.rec;
  const blackSeat = rec?.blackSeat ?? cur?.blackSeat ?? "A";
  const whiteSeat = blackSeat === "A" ? "B" : "A";
  const labels = rec?.labels ?? cur?.labels ?? v?.seats ?? { A: t("seatADefault"), B: t("seatBDefault") };
  $("black-name").textContent = `${labels[blackSeat]}  [${blackSeat}]`;
  $("white-name").textContent = `${labels[whiteSeat]}  [${whiteSeat}]`;
  const thinking = cur && !cur.result ? cur.thinking : null;
  for (const [color, id] of [["B", "black"], ["W", "white"]]) {
    const parts = [];
    if (cur) parts.push(t("captures", { n: cur.captures?.[color] ?? 0 }));
    if (thinking?.color === color) {
      const secs = (thinking.elapsed + Date.now() - app.viewAt) / 1000;
      parts.push(t("thinking", { s: secs.toFixed(1) }));
    }
    $(`${id}-meta`).textContent = parts.join(" · ");
    $(`pl-${id}`).classList.toggle("to-move", thinking?.color === color);
  }
}

function renderStatus(v) {
  const line = $("status-line");
  const dot = $("status-dot");
  if (dot) {
    dot.className = "status-dot" + (v?.paused ? " paused" : v?.running ? " live" : "");
  }
  if (app.deadScoring && !app.review) {
    line.textContent = t("statusMarkDead");
    return;
  }
  if (app.review) {
    line.textContent = t("statusReviewing", { game: app.review.rec.index + 1, result: app.review.rec.result });
    return;
  }
  if (app.role === "guest" && !v) {
    line.textContent = t("statusWaitingHost");
    return;
  }
  const cur = v?.current;
  if (!cur) {
    line.textContent = v?.running ? t("statusStarting") : t("statusIdle");
    return;
  }
  const prog = v.config ? ` (${Math.min(v.played + (cur.result ? 0 : 1), v.config.games)}/${v.config.games})` : "";
  const head = t("statusGameHead", { game: cur.index + 1, prog });
  if (cur.result) {
    const tail = v.paused ? t("statusPausedTail") : v.running ? "" : t("statusMatchOverTail");
    line.textContent = t("statusGameDone", { head, result: cur.result, reason: cur.reason, tail });
    return;
  }
  const side = cur.moves.length % 2 === 0 ? t("sideBlack") : t("sideWhite");
  const tail = v.paused ? t("statusPausingAfter") : "";
  line.textContent = t("statusMove", { head, move: cur.moves.length + 1, side, tail });
}

function renderControls(v) {
  const host = app.role === "host";
  const running = !!app.runner?.running;
  document.body.classList.toggle("guest", !host);
  document.body.classList.toggle("reviewing", !!app.review);
  $("m-start").disabled = !host || running;
  $("m-pause").disabled = !running || app.runner.paused;
  $("m-resume").disabled = !running || !app.runner.paused;
  $("m-stop").disabled = !running;
  for (const id of ["cfg-size", "cfg-komi", "cfg-ko", "cfg-games", "cfg-time", "cfg-maxmoves", "cfg-alternate", "b-kind"]) {
    $(id).disabled = running;
  }
  $("res-clear").disabled = running;
  $("my-engine-box").hidden = $("my-kind").value !== "engine";
  $("b-engine-box").hidden = $("b-kind").value !== "engine";

  const bRemote = $("b-kind").value === "remote";
  $("b-remote-status").hidden = !bRemote;
  if (bRemote) {
    $("b-remote-status").textContent = app.remote
      ? t("seatBConnected", { label: app.remote.player.label })
      : app.room
        ? t("seatBWaiting")
        : t("seatBInviteHint");
  }

  const badge = $("role-badge");
  if (app.role === "guest") {
    badge.textContent = app.mySeat
      ? t("badgeGuestSeat", { code: app.room?.code })
      : t("badgeWatching", { code: app.room?.code });
    badge.className = "badge guest";
  } else if (app.room) {
    badge.textContent = t("badgeHost", { code: app.room.code });
    badge.className = "badge host";
  } else {
    badge.textContent = t("badgeLocal");
    badge.className = "badge";
  }

  const human = activeHuman();
  const inDead = !!(app.deadScoring && !app.review);
  $("human-controls").hidden = !human || !!app.review || inDead;
  const undoBtn = $("btn-undo");
  if (undoBtn) {
    const canUndo = !!(
      host &&
      human &&
      app.runner?.running &&
      $("b-kind").value !== "remote" &&
      (app.runner.current?.game?.moves.length ?? 0) > (app.runner.current?.initialCount ?? 0)
    );
    undoBtn.hidden = !canUndo;
  }
  const deadBox = $("dead-controls");
  if (deadBox) {
    deadBox.hidden = !inDead;
    if (inDead) {
      const tt = app.deadScoring.game.trompTaylor(app.deadScoring.dead);
      $("dead-preview").textContent = t("deadPreviewText", {
        score: formatScore(tt.diff),
        dead: app.deadScoring.dead.size,
      });
    }
  }

  if (inDead) {
    boardView.setInteractive("dead");
  } else if (app.review && app.review.tryMode) {
    const { g } = buildReviewGame(app.review);
    boardView.setInteractive(g.toPlay);
  } else {
    boardView.setInteractive(human && !app.review ? colorFromLetter(human.pendingCtx.color) : null);
  }

  if (app.review) {
    const r = app.review;
    $("review-try").classList.toggle("active", !!r.tryMode);
    $("review-try-undo").hidden = r.variation.length === 0;
    $("review-try-reset").hidden = r.variation.length === 0;
    const vb = $("review-var-badge");
    vb.hidden = r.variation.length === 0;
    if (r.variation.length) vb.textContent = t("varBadge", { n: r.variation.length });
    const playBtn = $("review-play");
    if (playBtn) {
      playBtn.textContent = r.playTimer ? "⏸" : "▶︎";
      playBtn.classList.toggle("active", !!r.playTimer);
    }
    const resumeBtn = $("review-resume");
    if (resumeBtn) resumeBtn.disabled = !host || running;
  }

  const meReady = $("my-kind").value === "human" || !!app.myBridge?.info;
  const meErr = app.bridgeHintState.my?.kind === "err";
  $("dot-me").className = "sum-dot" + (meReady ? " ok" : meErr ? " err" : "");
  $("dot-room").className = "sum-dot" + (app.room ? (app.role === "guest" ? " info" : " ok") : "");
  const bReady = !!seatBPlayer();
  const bErr = $("b-kind").value === "engine" && app.bridgeHintState.b?.kind === "err";
  $("dot-match").className = "sum-dot" + (bReady ? " ok" : bErr ? " err" : "");

  const numBtn = $("btn-numbers");
  numBtn.classList.toggle("active", app.numberMode !== "last");
  numBtn.textContent = app.numberMode === "all"
    ? t("btnNumbersAll")
    : app.numberMode === "last5"
      ? t("btnNumbersLast5")
      : t("btnNumbers");

  const terrBtn = $("btn-territory");
  if (terrBtn) terrBtn.classList.toggle("active", app.showTerritory);

  const candBtn = $("btn-candidates");
  if (candBtn) {
    const allowed = canShowCandidates(v);
    candBtn.disabled = !allowed;
    candBtn.classList.toggle("active", app.showCandidates && allowed);
  }
}

function renderRoom() {
  $("room-idle").hidden = !!app.room;
  $("room-active").hidden = !app.room;
  if (!app.room) return;
  $("room-code").textContent = app.room.code;
  $("room-copy").hidden = app.role !== "host";
  const list = $("room-peers");
  list.replaceChildren();
  if (app.role === "host") {
    const n = app.peers.size;
    setHint("room-status", n ? t("roomGuestsCount", { n }) : t("roomShareHint"));
    for (const peer of app.peers.values()) {
      const li = document.createElement("li");
      li.textContent = t("roomPeerLine", { label: peer.label, role: peer.role });
      list.appendChild(li);
    }
  } else {
    setHint("room-status", app.mySeat ? t("roomGuestSeatB") : t("roomGuestWatching"), "ok");
  }
}

function inviteLink() {
  const params = new URLSearchParams({ room: app.room.code });
  const sig = $("net-signal").value.trim();
  if (sig) params.set("sig", sig);
  try {
    const ice = encodeIceParam($("net-ice").value);
    if (ice) params.set("ice", ice);
  } catch (e) {
    log(t("logInviteNetBad", { msg: e.message }));
  }
  return `${location.origin}${location.pathname}#${params}`;
}

function renderResults() {
  const recs = app.records;
  const decided = recs.filter((r) => !r.void);
  const pill = $("tab-results-count");
  if (pill) {
    pill.textContent = String(decided.length);
    pill.hidden = decided.length === 0;
  }

  const tbody = $("results-table").querySelector("tbody");
  tbody.replaceChildren();
  for (const r of [...recs].reverse()) {
    const tr = document.createElement("tr");
    const whiteSeat = r.blackSeat === "A" ? "B" : "A";
    const cls = [
      r.void ? "void" : r.winnerSeat === "A" ? "win-a" : r.winnerSeat === "B" ? "win-b" : "",
      app.review?.rec === r ? "reviewing" : "",
    ].filter(Boolean).join(" ");
    tr.className = cls;
    const cells = [
      String(r.index + 1),
      `${r.blackSeat}`,
      `${whiteSeat}`,
      r.result,
      String(r.moves.length),
      r.reason,
    ];
    cells.forEach((text, i) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (i === 5) td.className = "reason";
      if (i === 1 || i === 2) td.title = r.labels?.[text] ?? text;
      tr.appendChild(td);
    });
    tr.addEventListener("click", () => openReview(r));
    tbody.appendChild(tr);
  }

  const box = $("summary");
  box.replaceChildren();
  if (!decided.length) {
    const empty = document.createElement("div");
    empty.className = "summary-empty";
    empty.textContent = recs.length ? t("summaryVoidOnly") : t("summaryEmpty");
    box.appendChild(empty);
    return;
  }

  const s = summarize(recs);
  const labels = decided[decided.length - 1].labels ?? { A: "A", B: "B" };
  const pct = (x) => `${(100 * x).toFixed(1)}%`;
  const wld = (o) => `${o.w}-${o.l}${o.d ? `-${o.d}` : ""}`;
  const mk = (tag, cls, text = "") => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  };

  // Visual scoreboard + win-rate bar
  const sb = mk("div", "scoreboard");
  const plRow = mk("div", "sb-players");
  const pA = mk("span", "sb-a", `A: ${labels.A}`);
  pA.title = labels.A;
  const pB = mk("span", "sb-b", `B: ${labels.B}`);
  pB.title = labels.B;
  plRow.append(pA, pB);

  const scoreRow = mk("div", "sb-score-row");
  const big = mk("div", "sb-score");
  big.append(
    mk("span", "num-a", String(s.aWins)),
    mk("span", "sep", ":"),
    mk("span", "num-b", String(s.bWins)),
  );
  const metaParts = [t("kpiGamesCount", { n: s.games })];
  if (s.draws) metaParts.push(t("kpiDraws", { n: s.draws }));
  if (s.voids) metaParts.push(t("kpiVoids", { n: s.voids }));
  scoreRow.append(big, mk("span", "sb-meta", metaParts.join(" · ")));

  const bar = mk("div", "winbar");
  const wA = (s.aWins / s.games) * 100;
  const wD = (s.draws / s.games) * 100;
  const wB = (s.bWins / s.games) * 100;
  const bA = mk("div", "bar-a"); bA.style.width = `${wA}%`;
  const bD = mk("div", "bar-d"); bD.style.width = `${wD}%`;
  const bB = mk("div", "bar-b"); bB.style.width = `${wB}%`;
  bar.append(bA, bD, bB);
  sb.append(plRow, scoreRow, bar);

  // 2x2 KPI tiles
  const grid = mk("div", "kpi-grid");
  const addKpi = (label, val, sub) => {
    const k = mk("div", "kpi");
    k.append(mk("div", "kpi-label", label), mk("div", "kpi-val", val), mk("div", "kpi-sub", sub));
    grid.appendChild(k);
  };
  addKpi(t("kpiScore"), pct(s.score), `${pct(s.ci[0])} – ${pct(s.ci[1])}`);
  addKpi(t("kpiElo"), formatElo(s.elo), `${formatElo(s.eloCi[0])} – ${formatElo(s.eloCi[1])}`);
  addKpi(
    t("kpiLos"),
    pct(s.los),
    `${t("kpiColorSplit", { asB: wld(s.aAsBlack), asW: wld(s.aAsWhite) })} · ${t("kpiBlackWon", { bWins: s.blackWins, total: s.blackWins + s.whiteWins })}`,
  );
  addKpi(
    t("kpiPace"),
    t("kpiPaceVal", { avgA: (s.avgMs.A / 1000).toFixed(2), avgB: (s.avgMs.B / 1000).toFixed(2) }),
    t("kpiAvgMoves", { n: Math.round(s.avgLength) }),
  );

  // Accessible plain-text summary (preserves screen-reader & test readability)
  const sr = mk("div", "sr-summary");
  sr.textContent = [
    t("summaryLineAB", { a: s.aWins, b: s.bWins, draws: s.draws, games: s.games, voids: s.voids }),
    t("summaryScore", { score: pct(s.score), lo: pct(s.ci[0]), hi: pct(s.ci[1]) }),
    t("summaryElo", { elo: formatElo(s.elo), lo: formatElo(s.eloCi[0]), hi: formatElo(s.eloCi[1]), los: pct(s.los) }),
  ].join(" · ");

  box.append(sb, grid, sr);
}

function stopReviewPlay() {
  if (app.review?.playTimer) {
    clearInterval(app.review.playTimer);
    app.review.playTimer = null;
  }
}

function toggleReviewPlay() {
  if (!app.review) return;
  if (app.review.playTimer) {
    stopReviewPlay();
    update();
    return;
  }
  if (app.review.moveNo >= app.review.rec.moves.length) {
    app.review.moveNo = 0;
  }
  app.review.variation = [];
  app.review.varEval = null;
  const ms = Number($("review-speed")?.value) || 650;
  app.review.playTimer = setInterval(() => {
    if (!app.review) return stopReviewPlay();
    if (app.review.moveNo >= app.review.rec.moves.length) {
      stopReviewPlay();
      update();
      return;
    }
    app.review.moveNo++;
    $("review-slider").value = String(app.review.moveNo);
    const mv = app.review.rec.moves[app.review.moveNo - 1]?.[1] ?? "";
    if (String(mv).toLowerCase() === "pass") app.sound.playPass();
    else app.sound.playStone(0);
    update();
  }, ms);
  update();
}

function openReview(rec) {
  stopReviewPlay();
  app.review = { rec, moveNo: rec.moves.length, tryMode: false, variation: [], varEval: null, playTimer: null };
  $("review-bar").hidden = false;
  $("review-title").textContent = t("reviewTitle", { game: rec.index + 1, result: rec.result });
  const slider = $("review-slider");
  slider.max = String(rec.moves.length);
  slider.value = String(rec.moves.length);
  renderResults();
  update();
}

function stepReview(moveNo) {
  if (!app.review) return;
  stopReviewPlay();
  const max = app.review.rec.moves.length;
  app.review.moveNo = Math.max(0, Math.min(max, moveNo));
  app.review.variation = [];
  app.review.varEval = null;
  $("review-slider").value = String(app.review.moveNo);
  update();
}

function updateReviewLabel() {
  if (!app.review) return;
  const { rec, moveNo, variation } = app.review;
  $("review-title").textContent = t("reviewTitle", { game: rec.index + 1, result: rec.result });
  if (variation.length) {
    const last = variation[variation.length - 1];
    $("review-move").textContent = `+${variation.length}. ${last[0]} ${last[1]}`;
    return;
  }
  const mv = moveNo > 0 ? rec.moves[moveNo - 1] : null;
  $("review-move").textContent = mv ? t("reviewMove", { no: moveNo, c: mv[0], v: mv[1], s: ((mv[2] || 0) / 1000).toFixed(1) }) : t("reviewStart");
}

function update() {
  const v = currentView();
  renderBoard(v);
  renderAnalysis(v);
  renderPlayers(v);
  renderStatus(v);
  renderControls(v);
  renderRoom();
  updateReviewLabel();
  if (app.role === "host") broadcastState();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function applySoundToggle() {
  const btn = $("sound-toggle");
  if (!btn) return;
  const muted = !app.sound.enabled;
  btn.classList.toggle("muted", muted);
  const label = t(muted ? "soundUnmute" : "soundMute");
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

function applyTheme() {
  document.documentElement.dataset.theme = app.theme;
  const btn = $("theme-toggle");
  if (btn) {
    const label = t(app.theme === "dark" ? "themeToLight" : "themeToDark");
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }
}

function setTheme(theme) {
  app.theme = theme === "dark" ? "dark" : "light";
  try {
    localStorage.setItem(THEME_KEY, app.theme);
  } catch {
    // ignore
  }
  applyTheme();
}

function setTab(name) {
  app.tab = name;
  for (const btn of document.querySelectorAll(".tab[data-tab]")) {
    const active = btn.dataset.tab === name;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  }
  for (const pane of document.querySelectorAll(".tab-pane[data-pane]")) {
    pane.classList.toggle("active", pane.dataset.pane === name);
  }
}

function setLanguage(lang) {
  app.lang = lang === "zh" ? "zh" : "en";
  try {
    localStorage.setItem(LANG_KEY, app.lang);
  } catch {
    // ignore storage errors
  }
  applyDomTranslations(document, app.lang);
  applyTheme();
  applySoundToggle();
  refreshBridgeHints();
  if (app.runner?.running) {
    app.runner.setSeat("A", myPlayer() || app.runner.seats.A);
    app.runner.setSeat("B", seatBPlayer() || app.runner.seats.B);
  }
  if (app.role === "guest") sendHello();
  update();
  renderResults();
}

function onBoardClick(point) {
  // 1) Dead-stone marking after double-pass in human games
  if (app.deadScoring && !app.review) {
    const { game, dead } = app.deadScoring;
    if (game.board.stones[point] === 0) return;
    const { chain } = game.board.group(point);
    const markDead = !dead.has(point);
    for (const p of chain) {
      if (markDead) dead.add(p);
      else dead.delete(p);
    }
    update();
    return;
  }

  // 2) Variation exploration during review
  if (app.review) {
    if (!app.review.tryMode) return;
    stopReviewPlay();
    const { g } = buildReviewGame(app.review);
    const color = g.toPlay;
    if (!g.board.isLegal(color, point)) {
      $("status-line").textContent = t("illegalMove", { v: g.board.toGtp(point) });
      return;
    }
    const prevCap = g.board.captures[color];
    const vertex = g.board.toGtp(point);
    g.apply(color, vertex, 0);
    const captured = g.board.captures[color] - prevCap;
    app.review.variation.push([colorLetter(color), vertex, 0]);
    app.review.varEval = null;
    app.sound.playStone(captured);
    update();
    if (app.analyzer.capable) triggerVariationAnalysis();
    return;
  }

  // 3) Live human move
  const human = activeHuman();
  if (!human) return;
  const ctx = human.pendingCtx;
  const color = colorFromLetter(ctx.color);
  let g;
  try {
    g = new GameState(ctx.size, ctx.komi, ctx.koRule);
    for (const [c, v] of ctx.moves) g.apply(colorFromLetter(c), v, 0, { allowSameColor: true });
  } catch (e) {
    return log(t("logRebuildFail", { msg: e.message }));
  }
  if (!g.board.isLegal(color, point)) {
    $("status-line").textContent = t("illegalMove", { v: g.board.toGtp(point) });
    return;
  }
  human.submit(g.board.toGtp(point));
}

function init() {
  restoreInputs();
  applyDomTranslations(document, app.lang);
  applyTheme();
  applySoundToggle();
  setTab(app.tab);
  boardView = new BoardView($("board"), { onClick: onBoardClick });
  evalChart = new AnalysisChart($("eval-chart"), {
    onSelectMove: jumpToMoveFromChart,
    formatTooltip: (pt) => t("evalTooltip", {
      moveNo: pt.moveNo,
      wr: (pt.winrate * 100).toFixed(1),
      lead: formatLeadLocalized(pt.scoreLead),
    }),
  });

  app.analyzer.addEventListener("busy", (e) => {
    app.analysisBusy = !!e.detail?.busy;
    const dot = $("eval-busy-dot");
    if (dot) dot.hidden = !app.analysisBusy;
  });
  app.analyzer.addEventListener("result", (e) => {
    const entry = e.detail;
    // Variation analysis results stay isolated from main-line records
    if (String(entry.gameKey || "").startsWith("var:")) {
      if (app.review) {
        const expected = `var:${gameKeyOf(app.review.rec)}:${app.review.moveNo}:${app.review.variation.length}`;
        if (entry.gameKey === expected) {
          app.review.varEval = {
            moveNo: entry.moveNo,
            winrate: entry.winrate,
            scoreLead: entry.scoreLead,
            visits: entry.visits,
            moves: entry.moves,
          };
          update();
        }
      }
      return;
    }
    const map = getGameEvalMap(entry.gameKey, true);
    if (map) {
      map.set(entry.moveNo, {
        moveNo: entry.moveNo,
        winrate: entry.winrate,
        scoreLead: entry.scoreLead,
        visits: entry.visits,
        moves: entry.moves,
      });
    }
    // Also attach to matching finished record if analyzing in review mode
    if (app.review && gameKeyOf(app.review.rec) === entry.gameKey) {
      const rec = app.review.rec;
      if (!Array.isArray(rec.analysis)) rec.analysis = [];
      const idx = rec.analysis.findIndex((x) => x.moveNo === entry.moveNo);
      const slim = stripForRecord(entry);
      if (idx >= 0) rec.analysis[idx] = slim;
      else rec.analysis.push(slim);
      rec.analysis.sort((a, b) => a.moveNo - b.moveNo);
      saveRecords();
    }
    update();
  });
  app.analyzer.addEventListener("error", (e) => {
    const msg = e.detail?.error?.message;
    if (msg) log(t("logAnalyzeErr", { msg }));
  });

  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("room")) {
    $("join-code").value = hash.get("room");
    let loadedNet = false;
    if (hash.get("sig")) {
      $("net-signal").value = hash.get("sig");
      localStorage.setItem(`${STORE}ui.net-signal`, $("net-signal").value);
      loadedNet = true;
    }
    if (hash.get("ice")) {
      try {
        const prettyIce = decodeIceParam(hash.get("ice"));
        if (prettyIce) {
          $("net-ice").value = prettyIce;
          localStorage.setItem(`${STORE}ui.net-ice`, prettyIce);
          loadedNet = true;
        }
      } catch (e) {
        log(t("logInviteNetBad", { msg: e.message }));
      }
    }
    log(t("logInviteRestored", { room: hash.get("room") }));
    if (loadedNet) log(t("logInviteNetLoaded"));
  }

  app.records = loadRecords();
  if (app.records.length) log(t("logRestoredGames", { n: app.records.length }));

  $("lang-toggle").onclick = () => setLanguage(app.lang === "zh" ? "en" : "zh");
  $("theme-toggle").onclick = () => setTheme(app.theme === "dark" ? "light" : "dark");
  $("sound-toggle").onclick = () => {
    app.sound.setEnabled(!app.sound.enabled);
    applySoundToggle();
  };
  $("btn-territory").onclick = () => {
    app.showTerritory = !app.showTerritory;
    update();
  };
  $("btn-candidates").onclick = () => {
    app.showCandidates = !app.showCandidates;
    update();
  };
  $("btn-numbers").onclick = () => {
    const order = ["last", "last5", "all"];
    app.numberMode = order[(order.indexOf(app.numberMode) + 1) % order.length];
    update();
  };
  $("btn-analyze-now").onclick = triggerManualAnalysis;
  $("btn-analyze-full").onclick = toggleFullGameAnalysis;
  for (const btn of document.querySelectorAll(".seg-btn[data-chart-mode]")) {
    btn.onclick = () => {
      for (const b of document.querySelectorAll(".seg-btn[data-chart-mode]")) {
        b.classList.toggle("active", b === btn);
      }
      evalChart.setMode(btn.dataset.chartMode);
    };
  }
  $("cfg-share-eval").onchange = () => {
    if (app.role === "host") broadcastState();
  };
  for (const btn of document.querySelectorAll(".tab[data-tab]")) {
    btn.onclick = () => setTab(btn.dataset.tab);
  }
  $("my-connect").onclick = () => connectBridge("my");
  $("b-connect").onclick = () => connectBridge("b");
  $("ref-connect").onclick = () => connectBridge("ref");
  $("my-kind").onchange = () => {
    if ($("my-kind").value === "engine") app.myHuman.cancel();
    onSeatsChanged();
  };
  $("my-name").onchange = onSeatsChanged;
  $("join-watch").onchange = sendHello;
  $("b-kind").onchange = () => {
    if ($("b-kind").value !== "remote") releaseSeatB("seat B changed");
    else assignSeatB();
    update();
  };
  $("cfg-size").onchange = update;
  $("cfg-delay").onchange = () => {
    if (app.runner) app.runner.config.moveDelay = readConfig().moveDelay;
  };

  $("room-create").onclick = createRoom;
  $("room-join").onclick = joinRoom;
  $("room-leave").onclick = leaveRoom;
  $("room-copy").onclick = async () => {
    const link = inviteLink();
    try {
      await navigator.clipboard.writeText(link);
      log(t("logInviteCopied", { link }));
    } catch {
      prompt(t("promptCopyInvite"), link);
    }
  };

  $("m-start").onclick = () => startMatch();
  $("m-pause").onclick = () => app.runner?.pause();
  $("m-resume").onclick = () => {
    if (!app.runner) return;
    onSeatsChanged();
    if ($("b-kind").value === "remote" && !app.remote) return log(t("logWaitGuestRejoin"));
    app.runner.resume();
  };
  $("m-stop").onclick = () => {
    if (app.deadScoring) {
      app.deadScoring = null;
    }
    app.runner?.stop();
  };

  $("btn-undo").onclick = () => {
    if (!app.runner?.running) return;
    const bothHuman = $("my-kind").value === "human" && $("b-kind").value === "human";
    app.runner.requestUndo(bothHuman ? 1 : 2);
  };
  $("btn-pass").onclick = () => activeHuman()?.submit("pass");
  $("btn-resign").onclick = () => {
    if (confirm(t("confirmResign"))) activeHuman()?.submit("resign");
  };
  $("btn-dead-confirm").onclick = () => {
    if (!app.deadScoring) return;
    const { dead, resolve } = app.deadScoring;
    app.deadScoring = null;
    resolve(new Set(dead));
    update();
  };
  $("btn-dead-resume").onclick = () => {
    if (!app.deadScoring) return;
    const { resolve } = app.deadScoring;
    app.deadScoring = null;
    resolve(null);
    update();
  };
  for (const h of [app.myHuman, app.bHuman]) h.addEventListener("turn", update);

  $("review-slider").oninput = (e) => stepReview(Number(e.target.value));
  $("review-first").onclick = () => stepReview(0);
  $("review-prev10").onclick = () => app.review && stepReview(app.review.moveNo - 10);
  $("review-prev").onclick = () => app.review && stepReview(app.review.moveNo - 1);
  $("review-play").onclick = toggleReviewPlay;
  $("review-next").onclick = () => app.review && stepReview(app.review.moveNo + 1);
  $("review-next10").onclick = () => app.review && stepReview(app.review.moveNo + 10);
  $("review-last").onclick = () => app.review && stepReview(app.review.rec.moves.length);
  $("review-speed").onchange = () => {
    if (app.review?.playTimer) {
      stopReviewPlay();
      toggleReviewPlay();
    }
  };
  $("review-try").onclick = () => {
    if (!app.review) return;
    stopReviewPlay();
    app.review.tryMode = !app.review.tryMode;
    if (!app.review.tryMode) {
      app.review.variation = [];
      app.review.varEval = null;
    }
    update();
  };
  $("review-try-undo").onclick = () => {
    if (!app.review || !app.review.variation.length) return;
    app.review.variation.pop();
    app.review.varEval = null;
    update();
    if (app.review.variation.length && app.analyzer.capable) triggerVariationAnalysis();
  };
  $("review-try-reset").onclick = () => {
    if (!app.review) return;
    app.review.variation = [];
    app.review.varEval = null;
    update();
  };
  $("review-resume").onclick = resumeFromReview;
  $("review-close").onclick = () => {
    stopReviewPlay();
    stopFullAnalysis();
    app.review = null;
    $("review-bar").hidden = true;
    renderResults();
    update();
  };
  document.addEventListener("keydown", (e) => {
    if (!app.review) return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); stepReview(app.review.moveNo - (e.shiftKey ? 10 : 1)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); stepReview(app.review.moveNo + (e.shiftKey ? 10 : 1)); }
    else if (e.key === " ") { e.preventDefault(); toggleReviewPlay(); }
    else if (e.key === "Home") { e.preventDefault(); stepReview(0); }
    else if (e.key === "End") { e.preventDefault(); stepReview(app.review.rec.moves.length); }
    else if (e.key === "Escape") $("review-close").click();
  });
  $("review-sgf").onclick = () => app.review && download(`go-arena-game${app.review.rec.index + 1}.sgf`, recordToSgf(app.review.rec), "application/x-go-sgf");

  $("imp-sgf").onclick = () => $("imp-sgf-file").click();
  $("imp-sgf-file").onchange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      importSgfText(text);
    } catch (err) {
      log(t("logImpSgfFail", { msg: err.message }));
    }
  };
  $("imp-sgf-paste").onclick = () => {
    const text = prompt(t("promptPasteSgf"));
    if (text && text.trim()) importSgfText(text);
  };
  // Allow dragging and dropping .sgf files directly onto the window
  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  });
  window.addEventListener("drop", async (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file || !/\.(sgf|txt)$/i.test(file.name)) return;
    e.preventDefault();
    try {
      importSgfText(await file.text());
    } catch (err) {
      log(t("logImpSgfFail", { msg: err.message }));
    }
  });

  $("exp-sgf").onclick = () => {
    if (!app.records.some((r) => !r.void)) return log(t("logNoGamesExport"));
    download(`go-arena-${stamp()}.sgf`, recordsToSgfCollection(app.records), "application/x-go-sgf");
  };
  $("exp-csv").onclick = () => download(`go-arena-${stamp()}.csv`, recordsToCsv(app.records), "text/csv");
  $("exp-json").onclick = () => download(`go-arena-${stamp()}.json`, JSON.stringify(app.records, null, 1), "application/json");
  $("res-clear").onclick = () => {
    if (!confirm(t("confirmClear"))) return;
    app.records = [];
    saveRecords();
    broadcast({ t: "records", records: [] });
    renderResults();
  };

  window.addEventListener("beforeunload", (e) => {
    if (app.runner?.running || (app.role === "guest" && app.mySeat)) e.preventDefault();
  });

  // Live "thinking" timers.
  setInterval(() => {
    const v = app.role === "host" ? (app.runner ? app.runner.snapshot() : null) : app.view;
    if (v?.current?.thinking && !app.review) {
      if (app.role === "host") app.viewAt = Date.now();
      renderPlayers(app.role === "host" ? hostView() : v);
    }
  }, 250);

  update();
  renderResults();
  window.goArena = app; // for debugging in the console
}

init();
