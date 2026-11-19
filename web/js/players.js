// Players that can be seated in a match, and the client for the local GTP bridge.
//
// Every player implements:
//   kind                      "engine" | "human" | "remote"
//   label                     display name
//   requestMove(ctx) -> Promise<string>   GTP vertex, "pass" or "resign"
//   cancel()                  abandon the pending request (timeout / stop)
//
// ctx = { size, komi, koRule, color: "B"|"W", moves: [[color, vertex], ...], timePerMove }

export class Cancelled extends Error {
  constructor(message = "cancelled") {
    super(message);
    this.name = "Cancelled";
  }
}

export class Disconnected extends Error {
  constructor(message = "disconnected") {
    super(message);
    this.name = "Disconnected";
  }
}

// JSON request/response client for bridge/gtp_bridge.py.
export class BridgeClient extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.info = null;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new Error(`no answer from ${this.url}; is the bridge running?`));
      }, timeoutMs);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {};
      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          const why = ev.code === 1006 ? "connection refused or blocked (check the bridge and its --allow-origin)" : `closed (${ev.code})`;
          reject(new Error(`cannot connect to ${this.url}: ${why}`));
          return;
        }
        if (this.ws !== ws) return;
        this.ws = null;
        for (const { reject: rej, timer: t } of this.pending.values()) {
          clearTimeout(t);
          rej(new Disconnected("bridge connection closed"));
        }
        this.pending.clear();
        this.dispatchEvent(new Event("close"));
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg);
        else entry.reject(new Error(msg.error || "bridge error"));
      };
    });
  }

  request(op, params = {}, timeoutMs = 0) {
    if (!this.connected) return Promise.reject(new Disconnected("bridge not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`bridge did not answer ${op} within ${timeoutMs / 1000}s`));
          }, timeoutMs)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, op, ...params }));
    });
  }

  async hello() {
    this.info = await this.request("hello", {}, 180000);
    return this.info;
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Disconnected("bridge connection closed"));
    }
    this.pending.clear();
  }
}

export function engineLabel(info) {
  if (!info) return "engine";
  return [info.name, info.version].filter(Boolean).join(" ") || "engine";
}

export class EnginePlayer {
  constructor(client, owner = "") {
    this.kind = "engine";
    this.client = client;
    this.owner = owner;
  }

  get label() {
    const engine = engineLabel(this.client.info);
    return this.owner ? `${this.owner} (${engine})` : engine;
  }

  async requestMove(ctx) {
    const res = await this.client.request("genmove", {
      size: ctx.size,
      komi: ctx.komi,
      color: ctx.color,
      moves: ctx.moves.map(([c, v]) => [c, v]),
      timePerMove: ctx.timePerMove || 0,
    });
    return res.move;
  }

  cancel() {
    // Kill the engine so a long think does not block the next game; the
    // bridge restarts it on the next request.
    this.client.request("restart").catch(() => {});
  }

  async finalScore(ctx) {
    const res = await this.client.request("final_score", {
      size: ctx.size,
      komi: ctx.komi,
      moves: ctx.moves.map(([c, v]) => [c, v]),
    }, 120000);
    return res.score;
  }
}

// A person clicking on the board of this page. The app wires the board to
// submit()/cancel() while a request is pending.
export class HumanPlayer extends EventTarget {
  constructor(owner = "Human") {
    super();
    this.kind = "human";
    this.owner = owner;
    this.pendingCtx = null;
    this._resolve = null;
    this._reject = null;
  }

  get label() {
    return `${this.owner} (human)`;
  }

  requestMove(ctx) {
    this.cancel();
    return new Promise((resolve, reject) => {
      this.pendingCtx = ctx;
      this._resolve = resolve;
      this._reject = reject;
      this.dispatchEvent(new Event("turn"));
    });
  }

  submit(move) {
    if (!this._resolve) return;
    const resolve = this._resolve;
    this._clear();
    resolve(move);
  }

  cancel() {
    if (!this._reject) return;
    const reject = this._reject;
    this._clear();
    reject(new Cancelled());
  }

  _clear() {
    this.pendingCtx = null;
    this._resolve = null;
    this._reject = null;
    this.dispatchEvent(new Event("turn"));
  }
}

// The guest on the other end of a WebRTC data connection.
export class RemotePlayer {
  constructor(conn, info) {
    this.kind = "remote";
    this.conn = conn;
    this.info = info; // { label, kind }
    this.nextReq = 1;
    this.pending = new Map();
  }

  get label() {
    return this.info?.label || "remote player";
  }

  requestMove(ctx) {
    if (!this.conn.open) return Promise.reject(new Disconnected("remote player is not connected"));
    const req = this.nextReq++;
    return new Promise((resolve, reject) => {
      this.pending.set(req, { resolve, reject });
      this.conn.send({ t: "genmove", req, ...ctx });
    });
  }

  // Called by the host when the guest answers.
  handleMove(msg) {
    const entry = this.pending.get(msg.req);
    if (!entry) return;
    this.pending.delete(msg.req);
    if (msg.error) entry.reject(new Error(`remote: ${msg.error}`));
    else entry.resolve(msg.move);
  }

  cancel() {
    for (const [req, { reject }] of this.pending) {
      try {
        this.conn.send({ t: "cancel", req });
      } catch {
        // connection already gone
      }
      reject(new Cancelled());
    }
    this.pending.clear();
  }

  disconnect() {
    for (const { reject } of this.pending.values()) reject(new Disconnected("remote player left"));
    this.pending.clear();
  }
}
