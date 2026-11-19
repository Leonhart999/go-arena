// go-arena page controller: wires players, the room, the match runner and the UI.
import { BoardView } from "./board.js";
import { GameState, Board, colorFromLetter } from "./go.js";
import { BridgeClient, EnginePlayer, HumanPlayer, RemotePlayer, Cancelled, engineLabel } from "./players.js";
import { MatchRunner } from "./match.js";
import { HostRoom, GuestRoom, normalizeCode } from "./net.js";
import { summarize, formatElo } from "./stats.js";
import { recordToSgf, recordsToSgfCollection, recordsToCsv } from "./sgf.js";

const $ = (id) => document.getElementById(id);
const STORE = "go-arena.";
const PEER_TIMEOUT_MS = 20000;

const app = {
  role: "host", // "host" (also when no room is open) or "guest"
  myBridge: null,
  bBridge: null,
  refBridge: null,
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
    log("Could not save results in the browser (storage full?). Export them.");
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
  const text = $("net-ice").value.trim();
  let iceServers = null;
  if (text) {
    try {
      iceServers = JSON.parse(text);
      if (!Array.isArray(iceServers)) throw new Error("not an array");
    } catch (e) {
      throw new Error(`ICE servers must be a JSON array (${e.message})`);
    }
  }
  return { signalUrl: $("net-signal").value.trim(), iceServers };
}

// ---------------------------------------------------------------------------
// Players and seats
// ---------------------------------------------------------------------------
function myName() {
  return $("my-name").value.trim() || (app.role === "guest" ? "Guest" : "Host");
}

function myLabel() {
  if ($("my-kind").value === "human") return `${myName()} (human)`;
  const info = app.myBridge?.info;
  return info ? `${myName()} (${engineLabel(info)})` : `${myName()} (no engine)`;
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
      return app.bBridge?.info ? new EnginePlayer(app.bBridge, "Local B") : null;
    default:
      return app.bHuman;
  }
}

function seatBLabel() {
  switch ($("b-kind").value) {
    case "remote":
      return app.remote?.player.label ?? "(waiting for a guest)";
    case "engine":
      return app.bBridge?.info ? `Local B (${engineLabel(app.bBridge.info)})` : "(engine B not connected)";
    default:
      return app.bHuman.label;
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

async function connectBridge(which) {
  const spec = BRIDGES[which];
  const url = $(spec.url).value.trim();
  if (!url) return setHint(spec.status, "Enter the bridge address, e.g. ws://127.0.0.1:8765", "err");
  app[spec.key]?.close();
  app[spec.key] = null;
  const client = new BridgeClient(url);
  setHint(spec.status, `Connecting to ${url} ...`);
  try {
    await client.connect();
    setHint(spec.status, "Connected, waiting for the engine to start ...");
    const info = await client.hello();
    app[spec.key] = client;
    const scoring = info.commands?.includes("final_score") ? "" : " (no final_score)";
    setHint(spec.status, `Connected: ${engineLabel(info)}${which === "ref" ? scoring : ""}`, "ok");
    log(`Bridge ${url}: ${engineLabel(info)}`);
    client.addEventListener("close", () => {
      if (app[spec.key] !== client) return;
      app[spec.key] = null;
      setHint(spec.status, "Bridge disconnected. Restart it and press Connect.", "err");
      log(`Bridge ${url} disconnected`);
      onSeatsChanged();
    });
  } catch (e) {
    client.close();
    setHint(spec.status, e.message, "err");
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
  if (!a) return log("Seat A: connect your engine first (or choose to play by hand).");
  if (!b) return log("Seat B is empty: connect engine B or wait for a guest to join.");
  if (app.records.length && !confirm("Start a new match? The current results will be cleared (export them first if needed).")) return;
  const referee = app.refBridge?.info ? new EnginePlayer(app.refBridge, "referee") : null;
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
  runner.addEventListener("done", () => log("Match finished."));
  log(`Match started: ${a.label} vs ${b.label}, ${runner.config.games} games`);
  runner.run().catch((e) => {
    log(`Match error: ${e.message}`);
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
    return setHint("room-status", e.message, "err");
  }
  const room = new HostRoom();
  $("room-create").disabled = true;
  log("Opening room ...");
  try {
    await room.open(settings);
  } catch (e) {
    $("room-create").disabled = false;
    log(`Could not open a room: ${e.message}`);
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
  room.addEventListener("error", (e) => log(`Room: ${e.detail?.message ?? e.detail}`));
  app.pingTimer = setInterval(() => {
    broadcast({ t: "ping" });
    for (const [conn, peer] of app.peers) {
      if (Date.now() - peer.lastSeen > PEER_TIMEOUT_MS) {
        log(`${peer.label} stopped answering; dropping`);
        room.drop(conn);
      }
    }
  }, 5000);
  log(`Room ${room.code} is open.`);
  update();
}

function assignSeatB() {
  if ($("b-kind").value !== "remote" || app.remote || !app.room) return;
  for (const [conn, peer] of app.peers) {
    if (peer.want !== "player") continue;
    app.remote = { conn, player: new RemotePlayer(conn, { label: peer.label, kind: peer.kind }) };
    peer.role = "player";
    app.room.send(conn, { t: "welcome", seat: "B", host: myLabel() });
    log(`${peer.label} takes seat B`);
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
  log(`${peer?.label ?? "A guest"} left the room`);
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
  if (!code) return log("Enter the room code from the invite link.");
  let settings;
  try {
    settings = netSettings();
  } catch (e) {
    return log(e.message);
  }
  if (app.runner?.running) return log("Stop your own match before joining another room.");
  const room = new GuestRoom();
  $("room-join").disabled = true;
  log(`Joining room ${code} ...`);
  try {
    await room.join(settings, code);
  } catch (e) {
    $("room-join").disabled = false;
    log(`Could not join: ${e.message}`);
    return;
  }
  $("room-join").disabled = false;
  app.room = room;
  app.role = "guest";
  app.view = null;
  app.review = null;
  app.records = [];
  room.addEventListener("message", (e) => onGuestMessage(e.detail));
  room.addEventListener("close", () => {
    log("Connection to the host closed.");
    leaveRoom();
  });
  sendHello();
  log(`Joined room ${code}.`);
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
      if (app.mySeat !== msg.seat) log(msg.seat ? `You play seat B against ${msg.host}.` : `Watching ${msg.host}'s room.`);
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
  log("Left the room.");
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

function renderBoard(v) {
  if (app.review) {
    const { rec, moveNo } = app.review;
    const g = new GameState(rec.size, rec.komi, rec.koRule);
    try {
      for (const [c, mv, ms] of rec.moves.slice(0, moveNo)) g.apply(colorFromLetter(c), mv, ms);
    } catch (e) {
      console.warn(e);
    }
    const owner = moveNo === rec.moves.length && /Tromp-Taylor/.test(rec.reason) ? g.trompTaylor().owner : null;
    boardView.render({ size: rec.size, stones: g.board.stones, lastPoint: g.lastPoint, owner });
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
  const labels = rec?.labels ?? cur?.labels ?? v?.seats ?? { A: "Seat A", B: "Seat B" };
  $("black-name").textContent = `${labels[blackSeat]}  [${blackSeat}]`;
  $("white-name").textContent = `${labels[whiteSeat]}  [${whiteSeat}]`;
  const thinking = cur && !cur.result ? cur.thinking : null;
  for (const [color, id] of [["B", "black"], ["W", "white"]]) {
    const parts = [];
    if (cur) parts.push(`captures ${cur.captures?.[color] ?? 0}`);
    if (thinking?.color === color) {
      const secs = (thinking.elapsed + Date.now() - app.viewAt) / 1000;
      parts.push(`thinking ${secs.toFixed(1)}s`);
    }
    $(`${id}-meta`).textContent = parts.join(" · ");
    $(`pl-${id}`).classList.toggle("to-move", thinking?.color === color);
  }
}

function renderStatus(v) {
  const line = $("status-line");
  if (app.review) {
    line.textContent = `Reviewing game ${app.review.rec.index + 1}: ${app.review.rec.result}`;
    return;
  }
  if (app.role === "guest" && !v) {
    line.textContent = "Waiting for the host ...";
    return;
  }
  const cur = v?.current;
  if (!cur) {
    line.textContent = v?.running ? "Starting ..." : "Idle";
    return;
  }
  const head = `Game ${cur.index + 1}${v.config ? ` (${Math.min(v.played + (cur.result ? 0 : 1), v.config.games)} of ${v.config.games})` : ""}`;
  if (cur.result) {
    line.textContent = `${head}: ${cur.result}, ${cur.reason}${v.paused ? " · paused" : v.running ? "" : " · match over"}`;
    return;
  }
  const toMove = cur.moves.length % 2 === 0 ? "Black" : "White";
  line.textContent = `${head} · move ${cur.moves.length + 1} · ${toMove} to play${v.paused ? " · pausing after this move" : ""}`;
}

function renderControls(v) {
  const host = app.role === "host";
  const running = !!app.runner?.running;
  document.body.classList.toggle("guest", !host);
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
      ? `Seat B: ${app.remote.player.label}`
      : app.room
        ? "Seat B: waiting for a guest to join the room."
        : "Seat B: create a room and send the invite link to your opponent.";
  }

  const badge = $("role-badge");
  if (app.role === "guest") {
    badge.textContent = app.mySeat ? `guest · seat B · room ${app.room?.code}` : `watching room ${app.room?.code}`;
    badge.className = "badge guest";
  } else if (app.room) {
    badge.textContent = `host · room ${app.room.code}`;
    badge.className = "badge host";
  } else {
    badge.textContent = "local";
    badge.className = "badge";
  }

  const human = activeHuman();
  $("human-controls").hidden = !human || !!app.review;
  boardView.setInteractive(human && !app.review ? colorFromLetter(human.pendingCtx.color) : null);
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
    setHint("room-status", n ? `${n} guest${n > 1 ? "s" : ""} connected.` : "Share the invite link. Guests connect directly to this tab.");
    for (const peer of app.peers.values()) {
      const li = document.createElement("li");
      li.textContent = `${peer.label} · ${peer.role === "player" ? "seat B" : peer.role}`;
      list.appendChild(li);
    }
  } else {
    setHint("room-status", app.mySeat ? "You are seat B. Keep this tab open while the match runs." : "Watching.", "ok");
  }
}

function inviteLink() {
  const params = new URLSearchParams({ room: app.room.code });
  const sig = $("net-signal").value.trim();
  if (sig) params.set("sig", sig);
  return `${location.origin}${location.pathname}#${params}`;
}

function renderResults() {
  const recs = app.records;
  const tbody = $("results-table").querySelector("tbody");
  tbody.replaceChildren();
  for (const r of [...recs].reverse()) {
    const tr = document.createElement("tr");
    const whiteSeat = r.blackSeat === "A" ? "B" : "A";
    tr.className = r.void ? "void" : r.winnerSeat === "A" ? "win-a" : r.winnerSeat === "B" ? "win-b" : "";
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
  const decided = recs.filter((r) => !r.void);
  if (!decided.length) {
    box.textContent = recs.length ? "Only void games so far." : "No games yet.";
    return;
  }
  const s = summarize(recs);
  const labels = decided[decided.length - 1].labels ?? { A: "A", B: "B" };
  const pct = (x) => `${(100 * x).toFixed(1)}%`;
  const wld = (o) => `${o.w}-${o.l}${o.d ? `-${o.d}` : ""}`;
  box.replaceChildren();
  const add = (html, cls = "") => {
    const div = document.createElement("div");
    if (cls) div.className = cls;
    div.textContent = html;
    box.appendChild(div);
  };
  add(`A: ${labels.A}`);
  add(`B: ${labels.B}`);
  add(`A ${s.aWins} : ${s.bWins} B${s.draws ? ` (draws ${s.draws})` : ""} in ${s.games} games${s.voids ? `, ${s.voids} void` : ""}`, "big");
  add(`A score ${pct(s.score)}, 95% CI ${pct(s.ci[0])} to ${pct(s.ci[1])}`);
  add(`Elo A minus B ${formatElo(s.elo)} (95% CI ${formatElo(s.eloCi[0])} to ${formatElo(s.eloCi[1])}), LOS ${pct(s.los)}`);
  add(`A as Black ${wld(s.aAsBlack)}, as White ${wld(s.aAsWhite)} · Black won ${s.blackWins} of ${s.blackWins + s.whiteWins}`);
  add(`Avg time per move: A ${(s.avgMs.A / 1000).toFixed(2)}s, B ${(s.avgMs.B / 1000).toFixed(2)}s · avg length ${Math.round(s.avgLength)} moves`);
}

function openReview(rec) {
  app.review = { rec, moveNo: rec.moves.length };
  $("review-bar").hidden = false;
  $("review-title").textContent = `Game ${rec.index + 1} · ${rec.result}`;
  const slider = $("review-slider");
  slider.max = String(rec.moves.length);
  slider.value = String(rec.moves.length);
  update();
}

function updateReviewLabel() {
  if (!app.review) return;
  const { rec, moveNo } = app.review;
  const mv = moveNo > 0 ? rec.moves[moveNo - 1] : null;
  $("review-move").textContent = mv ? `${moveNo}. ${mv[0]} ${mv[1]} (${(mv[2] / 1000).toFixed(1)}s)` : "start";
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
function onBoardClick(point) {
  const human = activeHuman();
  if (!human || app.review) return;
  const ctx = human.pendingCtx;
  const color = colorFromLetter(ctx.color);
  let g;
  try {
    g = GameState.fromMoves(ctx.size, ctx.komi, ctx.koRule, ctx.moves);
  } catch (e) {
    return log(`Cannot rebuild the position: ${e.message}`);
  }
  if (!g.board.isLegal(color, point)) {
    $("status-line").textContent = `${g.board.toGtp(point)} is not a legal move.`;
    return;
  }
  human.submit(g.board.toGtp(point));
}

function init() {
  restoreInputs();
  boardView = new BoardView($("board"), { onClick: onBoardClick });

  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("room")) {
    $("join-code").value = hash.get("room");
    if (hash.get("sig")) $("net-signal").value = hash.get("sig");
    log(`Invite for room ${hash.get("room")}: set up your player, then press Join.`);
  }

  app.records = loadRecords();
  if (app.records.length) log(`Restored ${app.records.length} game(s) from the last session.`);

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
      log(`Invite link copied: ${link}`);
    } catch {
      prompt("Copy the invite link:", link);
    }
  };

  $("m-start").onclick = startMatch;
  $("m-pause").onclick = () => app.runner?.pause();
  $("m-resume").onclick = () => {
    if (!app.runner) return;
    onSeatsChanged();
    if ($("b-kind").value === "remote" && !app.remote) return log("Seat B is empty: wait for the guest to rejoin.");
    app.runner.resume();
  };
  $("m-stop").onclick = () => app.runner?.stop();

  $("btn-pass").onclick = () => activeHuman()?.submit("pass");
  $("btn-resign").onclick = () => {
    if (confirm("Resign this game?")) activeHuman()?.submit("resign");
  };
  for (const h of [app.myHuman, app.bHuman]) h.addEventListener("turn", update);

  $("review-slider").oninput = (e) => {
    if (!app.review) return;
    app.review.moveNo = Number(e.target.value);
    update();
  };
  $("review-close").onclick = () => {
    app.review = null;
    $("review-bar").hidden = true;
    update();
  };
  $("review-sgf").onclick = () => app.review && download(`go-arena-game${app.review.rec.index + 1}.sgf`, recordToSgf(app.review.rec), "application/x-go-sgf");

  $("exp-sgf").onclick = () => {
    if (!app.records.some((r) => !r.void)) return log("No finished games to export.");
    download(`go-arena-${stamp()}.sgf`, recordsToSgfCollection(app.records), "application/x-go-sgf");
  };
  $("exp-csv").onclick = () => download(`go-arena-${stamp()}.csv`, recordsToCsv(app.records), "text/csv");
  $("exp-json").onclick = () => download(`go-arena-${stamp()}.json`, JSON.stringify(app.records, null, 1), "application/json");
  $("res-clear").onclick = () => {
    if (!confirm("Delete all results on this page?")) return;
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
