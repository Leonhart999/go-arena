// Lightweight Web Audio API sound synthesizer for Go board events.
// Zero external audio files; fails silently in headless/test environments.

export const SOUND_KEY = "go-arena.sound";

export class SoundEffects {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.ctx = null;
    this.enabled = this._loadEnabled();
  }

  _loadEnabled() {
    try {
      const v = this.storage?.getItem(SOUND_KEY);
      if (v === "0") return false;
      if (v === "1") return true;
    } catch {
      // ignore
    }
    return true;
  }

  setEnabled(on) {
    this.enabled = !!on;
    try {
      this.storage?.setItem(SOUND_KEY, this.enabled ? "1" : "0");
    } catch {
      // ignore
    }
  }

  _ensureCtx() {
    if (!this.enabled) return null;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    if (!this.ctx) {
      try {
        this.ctx = new AC();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  // Crisp slate/shell-on-kaya-wood click (bandpass noise burst + short wooden body resonance)
  playStone(capturedCount = 0) {
    const ctx = this._ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;

    // 1) Short filtered noise impulse for the stone tap
    const len = Math.floor(ctx.sampleRate * 0.032);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const env = Math.exp(-i / (ctx.sampleRate * 0.0055));
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1650 + Math.random() * 260, now);
    filter.Q.setValueAtTime(1.8, now);

    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.32, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.032);

    noise.connect(filter).connect(nGain).connect(ctx.destination);
    noise.start(now);

    // 2) Low woody resonance thump
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(340 + Math.random() * 40, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.045);

    const oGain = ctx.createGain();
    oGain.gain.setValueAtTime(0.18, now);
    oGain.gain.exponentialRampToValueAtTime(0.001, now + 0.048);

    osc.connect(oGain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.05);

    // 3) Subtle clatter for captured stones
    if (capturedCount > 0) {
      const taps = Math.min(4, capturedCount);
      for (let k = 0; k < taps; k++) {
        this._stoneClack(ctx, now + 0.06 + k * 0.035, 0.14 - k * 0.02);
      }
    }
  }

  _stoneClack(ctx, when, vol) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(2200 + Math.random() * 500, when);
    osc.frequency.exponentialRampToValueAtTime(980, when + 0.022);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(0.03, vol), when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.024);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.026);
  }

  playPass() {
    const ctx = this._ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(420, now + 0.12);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.14);
  }

  playByoyomiTick(urgent = false) {
    const ctx = this._ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(urgent ? 980 : 720, now);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(urgent ? 0.14 : 0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  }

  playGameEnd() {
    const ctx = this._ensureCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const [offset, freq] of [[0, 523.25], [0.1, 659.25], [0.22, 783.99]]) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, now + offset);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.09, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.24);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.25);
    }
  }
}
