// go-arena page controller: wires players, the room, the match runner and the UI.
import { BoardView } from "./board.js";
import { GameState, Board, colorFromLetter } from "./go.js";
import { BridgeClient, EnginePlayer, HumanPlayer, RemotePlayer, Cancelled } from "./players.js";
import { MatchRunner } from "./match.js";
import { HostRoom, GuestRoom, normalizeCode, parseIceServers, encodeIceParam, decodeIceParam } from "./net.js";
import { summarize, formatElo } from "./stats.js";
import { recordToSgf, recordsToSgfCollection, recordsToCsv } from "./sgf.js";
import { LANG_KEY, applyDomTranslations, detectLang, translate } from "./i18n.js";

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
  showNumbers: false,
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
  records: [],
  view: null, // guest: latest state from the host
  viewAt: 0,
  review: null, // { rec, moveNo }
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
  return info ? `${myName()} (${t("engineSuffix")})` : `${myName()} (${t("noEngineSuffix")})`;
}

function myPlayer() {
  if ($("my-kind").value === "human") {
    app.myHuman.owner = myName();
    return app.myHuman;
  }
  return app.myBridge?.info ? new EnginePlayer(app.myBridge, myName(), t("engineSuffix")) : null;
}

function seatBPlayer() {
  switch ($("b-kind").value) {
    case "remote":
      return app.remote?.player ?? null;
    case "engine":
      return app.bBridge?.info ? new EnginePlayer(app.bBridge, t("localBName"), t("engineSuffix")) : null;
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
      return app.bBridge?.info ? `${t("localBName")} (${t("engineSuffix")})` : t("engineBNotConn");
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

function refreshBridgeHints() {
  for (const which of Object.keys(BRIDGES)) {
    const st = app.bridgeHintState[which];
    if (!st) continue;
    if (st.raw !== null) setHint(BRIDGES[which].status, st.raw, st.kind);
    else if (st.key === "bridgeConnected") {
      const info = app[BRIDGES[which].key]?.info;
      const extra = which === "ref" && info && !info.commands?.includes("final_score") ? t("bridgeNoScore") : "";
      setHint(BRIDGES[which].status, t("bridgeConnected", { label: t("bridgeReadyLabel"), extra }), st.kind);
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
  const client = new BridgeClient(url);
  setBridgeHint(which, "bridgeConnecting", { url });
  try {
    await client.connect();
    setBridgeHint(which, "bridgeWaitStart");
    const info = await client.hello();
    app[spec.key] = client;
    const label = t("bridgeReadyLabel");
    const extra = which === "ref" && !info.commands?.includes("final_score") ? t("bridgeNoScore") : "";
    setBridgeHint(which, "bridgeConnected", { label, extra }, "ok");
    log(t("logBridgeConnected", { url, label }));
    client.addEventListener("close", () => {
      if (app[spec.key] !== client) return;
      app[spec.key] = null;
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
// Match control (host)
// ---------------------------------------------------------------------------
function startMatch() {
  if (app.runner?.running) return;
  const a = myPlayer();
  const b = seatBPlayer();
  if (!a) return log(t("logNeedSeatA"));
  if (!b) return log(t("logNeedSeatB"));
  if (app.records.length && !confirm(t("confirmNewMatch"))) return;
  const referee = app.refBridge?.info ? new EnginePlayer(app.refBridge, "referee", t("engineSuffix")) : null;
  const runner = new MatchRunner(readConfig(), { A: a, B: b }, { referee });
  app.runner = runner;
  app.records = [];
  app.review = null;
  saveRecords();
  broadcast({ t: "records", records: [] });
  runner.addEventListener("state", update);
  runner.addEventListener("move", update);
  runner.addEventListener("log", (e) => log(e.detail));
  runner.addEventListener("record", (e) => {
    app.records.push(e.detail);
    saveRecords();
    broadcast({ t: "record", record: e.detail });
    renderResults();
  });
  runner.addEventListener("done", () => log(t("logMatchDone")));
  log(t("logMatchStart", { a: a.label, b: b.label, games: runner.config.games }));
  setTab("results");
  runner.run().catch((e) => {
    log(t("logMatchError", { msg: e.message }));
    console.error(e);
  });
  update();
}

function hostView() {
  const v = app.runner ? app.runner.snapshot() : { running: false, paused: false, config: readConfig(), current: null };
  if (!v.running) v.seats = { A: myLabel(), B: seatBLabel() };
  v.played = app.records.filter((r) => !r.void).length;
  return v;
}

function currentView() {
  if (app.role === "host") {
    app.viewAt = Date.now();
    return hostView();
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
  broadcast({ t: "state", view: hostView() });
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
    case "state":
      app.view = msg.view;
      app.viewAt = Date.now();
      update();
      break;
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
      game.apply(colorFromLetter(c), v, ms);
    }
  } catch (e) {
    console.warn("replay failed", e);
  }
  return game;
}

function computeMoveNumbers(board, moves) {
  if (!app.showNumbers || !moves?.length) return null;
  const map = new Map();
  for (let i = 0; i < moves.length; i++) {
    const mv = String(moves[i][1] ?? "").trim();
    if (!mv || mv.toLowerCase() === "pass") continue;
    try {
      const p = board.fromGtp(mv);
      if (p >= 0 && board.stones[p] !== 0) map.set(p, i + 1);
    } catch {
      // ignore invalid coordinate
    }
  }
  return map;
}

function renderBoard(v) {
  if (app.review) {
    const { rec, moveNo } = app.review;
    const g = new GameState(rec.size, rec.komi, rec.koRule);
    const slice = rec.moves.slice(0, moveNo);
    try {
      for (const [c, mv, ms] of slice) g.apply(colorFromLetter(c), mv, ms);
    } catch (e) {
      console.warn(e);
    }
    const owner = moveNo === rec.moves.length && /Tromp-Taylor/.test(rec.reason) ? g.trompTaylor().owner : null;
    boardView.render({
      size: rec.size,
      stones: g.board.stones,
      lastPoint: g.lastPoint,
      owner,
      moveNumbers: computeMoveNumbers(g.board, slice),
    });
    return;
  }
  const cur = v?.current;
  if (cur) {
    const g = replayFor(cur);
    boardView.render({
      size: cur.size,
      stones: g.board.stones,
      lastPoint: g.lastPoint,
      owner: cur.owner ? Uint8Array.from(cur.owner) : null,
      moveNumbers: computeMoveNumbers(g.board, cur.moves),
    });
  } else {
    const size = v?.config?.size ?? (Number($("cfg-size").value) || 19);
    boardView.render({ size, stones: new Board(size, "simple").stones, lastPoint: null });
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
  $("human-controls").hidden = !human || !!app.review;
  boardView.setInteractive(human && !app.review ? colorFromLetter(human.pendingCtx.color) : null);

  const meReady = $("my-kind").value === "human" || !!app.myBridge?.info;
  const meErr = app.bridgeHintState.my?.kind === "err";
  $("dot-me").className = "sum-dot" + (meReady ? " ok" : meErr ? " err" : "");
  $("dot-room").className = "sum-dot" + (app.room ? (app.role === "guest" ? " info" : " ok") : "");
  const bReady = !!seatBPlayer();
  const bErr = $("b-kind").value === "engine" && app.bridgeHintState.b?.kind === "err";
  $("dot-match").className = "sum-dot" + (bReady ? " ok" : bErr ? " err" : "");
  $("btn-numbers").classList.toggle("active", app.showNumbers);
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

function openReview(rec) {
  app.review = { rec, moveNo: rec.moves.length };
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
  const max = app.review.rec.moves.length;
  app.review.moveNo = Math.max(0, Math.min(max, moveNo));
  $("review-slider").value = String(app.review.moveNo);
  update();
}

function updateReviewLabel() {
  if (!app.review) return;
  const { rec, moveNo } = app.review;
  $("review-title").textContent = t("reviewTitle", { game: rec.index + 1, result: rec.result });
  const mv = moveNo > 0 ? rec.moves[moveNo - 1] : null;
  $("review-move").textContent = mv ? t("reviewMove", { no: moveNo, c: mv[0], v: mv[1], s: (mv[2] / 1000).toFixed(1) }) : t("reviewStart");
}

function update() {
  const v = currentView();
  renderBoard(v);
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
  const human = activeHuman();
  if (!human || app.review) return;
  const ctx = human.pendingCtx;
  const color = colorFromLetter(ctx.color);
  let g;
  try {
    g = GameState.fromMoves(ctx.size, ctx.komi, ctx.koRule, ctx.moves);
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
  setTab(app.tab);
  boardView = new BoardView($("board"), { onClick: onBoardClick });

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
  $("btn-numbers").onclick = () => {
    app.showNumbers = !app.showNumbers;
    update();
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

  $("m-start").onclick = startMatch;
  $("m-pause").onclick = () => app.runner?.pause();
  $("m-resume").onclick = () => {
    if (!app.runner) return;
    onSeatsChanged();
    if ($("b-kind").value === "remote" && !app.remote) return log(t("logWaitGuestRejoin"));
    app.runner.resume();
  };
  $("m-stop").onclick = () => app.runner?.stop();

  $("btn-pass").onclick = () => activeHuman()?.submit("pass");
  $("btn-resign").onclick = () => {
    if (confirm(t("confirmResign"))) activeHuman()?.submit("resign");
  };
  for (const h of [app.myHuman, app.bHuman]) h.addEventListener("turn", update);

  $("review-slider").oninput = (e) => stepReview(Number(e.target.value));
  $("review-first").onclick = () => stepReview(0);
  $("review-prev").onclick = () => app.review && stepReview(app.review.moveNo - 1);
  $("review-next").onclick = () => app.review && stepReview(app.review.moveNo + 1);
  $("review-last").onclick = () => app.review && stepReview(app.review.rec.moves.length);
  $("review-close").onclick = () => {
    app.review = null;
    $("review-bar").hidden = true;
    renderResults();
    update();
  };
  document.addEventListener("keydown", (e) => {
    if (!app.review) return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); stepReview(app.review.moveNo - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); stepReview(app.review.moveNo + 1); }
    else if (e.key === "Home") { e.preventDefault(); stepReview(0); }
    else if (e.key === "End") { e.preventDefault(); stepReview(app.review.rec.moves.length); }
    else if (e.key === "Escape") $("review-close").click();
  });
  $("review-sgf").onclick = () => app.review && download(`go-arena-game${app.review.rec.index + 1}.sgf`, recordToSgf(app.review.rec), "application/x-go-sgf");

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
