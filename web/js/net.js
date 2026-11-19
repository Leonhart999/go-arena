// WebRTC rooms over PeerJS. The host owns the match; guests receive state
// and answer move requests. Peer ids are "go-arena-<room code>".
/* global Peer */

const PREFIX = "go-arena-";
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

// Google's STUN server is unreachable from mainland China, so reachable ones
// go first. The PeerJS TURN relay is a fallback for strict NATs; moves are
// tiny, so a far-away relay is still fast enough.
export const DEFAULT_ICE = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.miwifi.com:3478", "stun:stun.l.google.com:19302"] },
  {
    urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"],
    username: "peerjs",
    credential: "peerjsp",
  },
];

export function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export function normalizeCode(text) {
  return String(text ?? "").trim().toLowerCase().replace(/^go-arena-/, "");
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

function openPeer(id, settings, timeoutMs = 15000) {
  if (typeof Peer === "undefined") return Promise.reject(new Error("PeerJS failed to load"));
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, peerOptions(settings)) : new Peer(peerOptions(settings));
    const timer = setTimeout(() => {
      peer.destroy();
      reject(new Error("signaling server did not answer; check the network settings"));
    }, timeoutMs);
    peer.once("open", () => {
      clearTimeout(timer);
      resolve(peer);
    });
    peer.once("error", (err) => {
      clearTimeout(timer);
      peer.destroy();
      reject(err);
    });
  });
}

function keepSignaling(peer, isClosed) {
  // Losing the signaling server does not drop open data channels, but new
  // guests cannot find the room until we reconnect.
  peer.on("disconnected", () => {
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

  async open(settings, code = null) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const tryCode = code || newRoomCode();
      try {
        this.peer = await openPeer(PREFIX + tryCode, settings);
        this.code = tryCode;
        break;
      } catch (err) {
        if (err.type === "unavailable-id" && !code) continue;
        throw err;
      }
    }
    if (!this.peer) throw new Error("could not get a free room code");
    keepSignaling(this.peer, () => this.closed);
    this.peer.on("error", (err) => this.emit("error", err));
    this.peer.on("connection", (conn) => {
      conn.on("open", () => {
        this.conns.add(conn);
        this.emit("join", conn);
      });
      conn.on("data", (msg) => this.emit("message", { conn, msg }));
      const gone = () => {
        if (this.conns.delete(conn)) this.emit("leave", conn);
      };
      conn.on("close", gone);
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

  async join(settings, code, timeoutMs = 25000) {
    this.code = normalizeCode(code);
    this.peer = await openPeer(null, settings);
    keepSignaling(this.peer, () => this.closed);
    const conn = this.peer.connect(PREFIX + this.code, { reliable: true, serialization: "json" });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("could not reach the host (wrong code, host offline, or the network blocks WebRTC; try a TURN server)")),
        timeoutMs,
      );
      conn.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      conn.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      this.peer.once("error", (err) => {
        clearTimeout(timer);
        reject(err.type === "peer-unavailable" ? new Error(`no room "${this.code}" is open`) : err);
      });
    }).catch((err) => {
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
