// WebRTC rooms over PeerJS. The host owns the match; guests receive state
// and answer move requests. Peer ids are "go-arena-<room code>".
/* global Peer */

const PREFIX = "go-arena-";
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

// Reachable mainland-China-friendly STUN servers first, followed by global fallbacks.
// (PeerJS's legacy eu-0/us-0.turn.peerjs.com domains are no longer resolvable;
// users behind symmetric/strict NATs can provide their own TURN server in Network settings.)
export const DEFAULT_ICE = [
  {
    urls: [
      "stun:stun.miwifi.com:3478",
      "stun:stun.chat.bilibili.com:3478",
      "stun:stun.cloudflare.com:3478",
      "stun:global.stun.twilio.com:3478",
      "stun:stun.l.google.com:19302",
    ],
  },
];

export function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export function normalizeCode(text) {
  return String(text ?? "").trim().toLowerCase().replace(/^go-arena-/, "");
}

// Parse & sanitize an ICE servers JSON array string (returns null if empty).
export function parseIceServers(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`ICE servers must be a JSON array (${e.message})`);
  }
  if (!Array.isArray(parsed)) throw new Error("ICE servers must be a JSON array");
  const clean = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("each ICE entry must be an object with urls");
    }
    const urls = Array.isArray(item.urls) ? item.urls.map(String) : item.urls ? String(item.urls) : null;
    if (!urls || (Array.isArray(urls) && !urls.length)) {
      throw new Error("each ICE entry must have a non-empty urls field");
    }
    const entry = { urls };
    if (item.username !== undefined) entry.username = String(item.username);
    if (item.credential !== undefined) entry.credential = String(item.credential);
    clean.push(entry);
  }
  return clean;
}

export function encodeIceParam(text) {
  const clean = parseIceServers(text);
  return clean?.length ? JSON.stringify(clean) : "";
}

export function decodeIceParam(raw) {
  const clean = parseIceServers(raw);
  return clean?.length ? JSON.stringify(clean, null, 2) : "";
}

// settings: { signalUrl: "" | "https://host:port/path", iceServers: [] | null }
function peerOptions(settings = {}) {
  const opts = { debug: 1, config: { iceServers: settings.iceServers?.length ? settings.iceServers : DEFAULT_ICE } };
  if (settings.signalUrl) {
    const u = new URL(settings.signalUrl);
    opts.secure = u.protocol === "https:";
    opts.host = u.hostname;
    opts.port = u.port ? Number(u.port) : opts.secure ? 443 : 80;
    opts.path = u.pathname || "/";
  }
  return opts;
}

function candidateType(cand) {
  if (!cand) return null;
  if (cand.type) return cand.type;
  const m = /\btyp\s+(\w+)/.exec(cand.candidate || "");
  return m ? m[1] : "unknown";
}

function attachIceDiagnostics(conn, tag, onDiag) {
  const counts = { host: 0, srflx: 0, prflx: 0, relay: 0 };
  const errors = [];
  let attachedPc = null;
  let lastIce = "new";
  let lastGather = "new";
  let done = false;

  const summary = () =>
    `ice=${lastIce}, gather=${lastGather}, candidates(host=${counts.host}, srflx=${counts.srflx}, relay=${counts.relay})` +
    (errors.length ? `, stun/turn_errors=${errors.length}` : "");

  const bindPc = (pc) => {
    if (!pc || pc === attachedPc) return;
    attachedPc = pc;
    lastIce = pc.iceConnectionState || "new";
    lastGather = pc.iceGatheringState || "new";
    onDiag(`${tag}: PeerConnection created (ice=${lastIce}, gather=${lastGather})`);

    pc.addEventListener("icegatheringstatechange", () => {
      lastGather = pc.iceGatheringState;
      onDiag(`${tag}: ICE gathering -> ${lastGather}`);
    });
    pc.addEventListener("iceconnectionstatechange", () => {
      lastIce = pc.iceConnectionState;
      onDiag(`${tag}: ICE state -> ${lastIce} (${summary()})`);
    });
    pc.addEventListener("connectionstatechange", () => {
      onDiag(`${tag}: WebRTC connection -> ${pc.connectionState}`);
    });
    pc.addEventListener("icecandidate", (ev) => {
      if (!ev.candidate) {
        onDiag(`${tag}: ICE gathering complete (${summary()})`);
        return;
      }
      const typ = candidateType(ev.candidate);
      if (typ in counts) counts[typ]++;
      const proto = ev.candidate.protocol || "";
      const addr = ev.candidate.address || "";
      const port = ev.candidate.port ? `:${ev.candidate.port}` : "";
      onDiag(`${tag}: +candidate ${typ} ${proto}${addr ? ` ${addr}${port}` : ""}`.trim());
    });
    pc.addEventListener("icecandidateerror", (ev) => {
      const msg = `${ev.url || "ice"} code=${ev.errorCode} ${ev.errorText || ""}`.trim();
      errors.push(msg);
      onDiag(`${tag}: ICE candidate error: ${msg}`);
    });
  };

  let tries = 0;
  const poll = () => {
    if (done) return;
    if (conn.peerConnection) {
      bindPc(conn.peerConnection);
      return;
    }
    if (++tries < 20) setTimeout(poll, 50);
  };
  poll();

  return {
    summary,
    counts,
    errors,
    stop() {
      done = true;
    },
    diagnoseFailure() {
      const hints = [];
      if (counts.srflx === 0) hints.push("no public srflx address from STUN (proxy TUN mode or UDP blocked?)");
      if (counts.relay === 0) hints.push("no relay (TURN) candidate available for strict NAT traversal");
      if (errors.length) hints.push(`ICE errors: ${errors.slice(0, 2).join("; ")}`);
      return `${summary()}${hints.length ? ` — ${hints.join("; ")}` : ""}`;
    },
  };
}

function openPeer(id, settings, onDiag = () => {}, timeoutMs = 15000) {
  if (typeof Peer === "undefined") return Promise.reject(new Error("PeerJS failed to load"));
  const opts = peerOptions(settings);
  const sigDesc = settings.signalUrl || "wss://0.peerjs.com (PeerJS cloud)";
  const iceDesc = settings.iceServers?.length ? `${settings.iceServers.length} custom ICE entry(ies)` : "default STUN list (no built-in TURN)";
  onDiag(`Signaling: connecting to ${sigDesc}; ${iceDesc}`);

  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, opts) : new Peer(opts);
    const timer = setTimeout(() => {
      peer.destroy();
      reject(new Error(`signaling server (${sigDesc}) did not answer; check network or proxy`));
    }, timeoutMs);
    peer.once("open", (assignedId) => {
      clearTimeout(timer);
      onDiag(`Signaling: connected (peer=${assignedId})`);
      resolve(peer);
    });
    peer.once("error", (err) => {
      clearTimeout(timer);
      onDiag(`Signaling error (${err.type || "error"}): ${err.message}`);
      peer.destroy();
      reject(err);
    });
  });
}

function keepSignaling(peer, isClosed, onDiag = () => {}) {
  // Losing the signaling server does not drop open data channels, but new
  // guests cannot find the room until we reconnect.
  peer.on("disconnected", () => {
    onDiag("Signaling: disconnected from server, reconnecting ...");
    if (!isClosed()) setTimeout(() => !isClosed() && !peer.destroyed && peer.reconnect(), 2000);
  });
}

export class HostRoom extends EventTarget {
  constructor() {
    super();
    this.peer = null;
    this.code = null;
    this.conns = new Set();
    this.closed = false;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  diag(text) {
    this.emit("diag", text);
  }

  async open(settings, code = null) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const tryCode = code || newRoomCode();
      try {
        this.peer = await openPeer(PREFIX + tryCode, settings, (m) => this.diag(m));
        this.code = tryCode;
        break;
      } catch (err) {
        if (err.type === "unavailable-id" && !code) continue;
        throw err;
      }
    }
    if (!this.peer) throw new Error("could not get a free room code");
    keepSignaling(this.peer, () => this.closed, (m) => this.diag(m));
    this.peer.on("error", (err) => {
      this.diag(`Peer error (${err.type || "error"}): ${err.message}`);
      this.emit("error", err);
    });
    this.peer.on("connection", (conn) => {
      this.diag(`Incoming guest connection (${conn.peer})`);
      const tracker = attachIceDiagnostics(conn, `Host<-${conn.peer.slice(-6)}`, (m) => this.diag(m));
      conn.on("open", () => {
        this.diag(`Guest DataChannel open (${tracker.summary()})`);
        this.conns.add(conn);
        this.emit("join", conn);
      });
      conn.on("data", (msg) => this.emit("message", { conn, msg }));
      const gone = (err) => {
        tracker.stop();
        if (err) this.diag(`Guest connection error: ${err.message || err}`);
        if (this.conns.delete(conn)) this.emit("leave", conn);
      };
      conn.on("close", () => gone());
      conn.on("error", gone);
    });
    return this.code;
  }

  send(conn, msg) {
    if (conn.open) conn.send(msg);
  }

  broadcast(msg) {
    for (const conn of this.conns) this.send(conn, msg);
  }

  drop(conn) {
    conn.close();
    if (this.conns.delete(conn)) this.emit("leave", conn);
  }

  close() {
    this.closed = true;
    this.peer?.destroy();
    this.conns.clear();
  }
}

export class GuestRoom extends EventTarget {
  constructor() {
    super();
    this.peer = null;
    this.conn = null;
    this.code = null;
    this.closed = false;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  diag(text) {
    this.emit("diag", text);
  }

  async join(settings, code, timeoutMs = 25000) {
    this.code = normalizeCode(code);
    this.peer = await openPeer(null, settings, (m) => this.diag(m));
    keepSignaling(this.peer, () => this.closed, (m) => this.diag(m));
    this.diag(`Connecting WebRTC DataChannel to room ${this.code} ...`);
    const conn = this.peer.connect(PREFIX + this.code, { reliable: true, serialization: "json" });
    const tracker = attachIceDiagnostics(conn, `Guest->${this.code}`, (m) => this.diag(m));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const diag = tracker.diagnoseFailure();
        this.diag(`Join timed out: ${diag}`);
        reject(new Error(`could not reach the host (${diag})`));
      }, timeoutMs);
      conn.once("open", () => {
        clearTimeout(timer);
        this.diag(`WebRTC DataChannel open (${tracker.summary()})`);
        resolve();
      });
      conn.once("error", (err) => {
        clearTimeout(timer);
        this.diag(`DataChannel error: ${err?.message || err} (${tracker.diagnoseFailure()})`);
        reject(err);
      });
      this.peer.once("error", (err) => {
        clearTimeout(timer);
        const msg = err.type === "peer-unavailable" ? `no room "${this.code}" is open on this signaling server` : err.message;
        this.diag(`Peer error (${err.type || "error"}): ${msg}`);
        reject(err.type === "peer-unavailable" ? new Error(msg) : err);
      });
    }).catch((err) => {
      tracker.stop();
      this.close();
      throw err;
    });
    this.conn = conn;
    conn.on("data", (msg) => this.emit("message", msg));
    conn.on("close", () => !this.closed && this.emit("close"));
    conn.on("error", () => !this.closed && this.emit("close"));
  }

  send(msg) {
    if (this.conn?.open) this.conn.send(msg);
  }

  close() {
    this.closed = true;
    this.peer?.destroy();
  }
}
