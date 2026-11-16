/**
 * All game audio is synthesised at runtime — there are no asset files, so the
 * single-file build stays single-file.
 *
 * The context is created lazily from a real user gesture (`unlock()`), because
 * browsers refuse to start audio without one. Every method is a no-op until
 * then, and errors are swallowed: a machine with no audio device must still be
 * able to play the game.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private _muted = false;

  get muted(): boolean {
    return this._muted;
  }

  /** Call from a click/keypress. Safe (and cheap) to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
      return;
    }

    try {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = this._muted ? 0 : 0.5;
      master.connect(ctx.destination);

      // One second of white noise, reused by every percussive sound.
      const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate), ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < data.length; i++) {
        // Slight smoothing takes the harshest edge off pure white noise.
        last = (last + (Math.random() * 2 - 1)) * 0.5;
        data[i] = last;
      }

      this.ctx = ctx;
      this.master = master;
      this.noise = buffer;
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    } catch {
      // No audio this session; the game carries on silently.
      this.ctx = null;
    }
  }

  toggleMute(): boolean {
    this._muted = !this._muted;
    const ctx = this.ctx;
    const master = this.master;
    if (ctx && master) {
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setTargetAtTime(this._muted ? 0 : 0.5, now, 0.02);
    }
    return this._muted;
  }

  /** Red ore collected: a bright, rising two-note ping. */
  ore(): void {
    this.tone({ type: 'triangle', from: 660, to: 990, duration: 0.12, gain: 0.16 });
    this.tone({ type: 'sine', from: 1320, to: 1760, duration: 0.16, gain: 0.08, delay: 0.055 });
  }

  /** Player cannon. Kept quiet and short because it fires often. */
  fire(): void {
    this.tone({ type: 'square', from: 780, to: 200, duration: 0.075, gain: 0.05, filter: 2200 });
  }

  /** Raider cannon: lower and more mechanical than the player's. */
  enemyFire(): void {
    this.tone({ type: 'sawtooth', from: 300, to: 110, duration: 0.18, gain: 0.05, filter: 900 });
  }

  /** Docking: a four-note major arpeggio, the "you banked it" reward. */
  docked(): void {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((frequency, i) => {
      this.tone({
        type: 'triangle',
        from: frequency,
        duration: 0.3,
        gain: 0.1,
        delay: i * 0.085,
        filter: 4000,
      });
    });
  }

  /** Raider destroyed: noise crack plus a falling sub. */
  raiderDown(): void {
    this.burst({ duration: 0.45, gain: 0.18, from: 1800, to: 90 });
    this.tone({ type: 'sine', from: 150, to: 38, duration: 0.5, gain: 0.16 });
  }

  /** Hull breach. The run is over; this is allowed to be loud. */
  crash(): void {
    this.burst({ duration: 0.9, gain: 0.3, from: 2400, to: 60 });
    this.tone({ type: 'sawtooth', from: 130, to: 32, duration: 0.9, gain: 0.16, filter: 600 });
  }

  /** Hull hit from an enemy bolt: sharp warning, not a full crash. */
  hit(): void {
    this.burst({ duration: 0.28, gain: 0.14, from: 1200, to: 220, type: 'bandpass' });
    this.tone({ type: 'sawtooth', from: 220, to: 90, duration: 0.18, gain: 0.08, filter: 900 });
  }

  /** A graze: short filtered noise, panned by nothing and mixed low. */
  nearMiss(): void {
    this.burst({ duration: 0.22, gain: 0.06, from: 700, to: 2600, type: 'bandpass' });
  }

  private tone(opts: {
    type: OscillatorType;
    from: number;
    to?: number;
    duration: number;
    gain: number;
    delay?: number;
    filter?: number;
  }): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    try {
      const start = ctx.currentTime + (opts.delay ?? 0);
      const end = start + opts.duration;

      const osc = ctx.createOscillator();
      osc.type = opts.type;
      osc.frequency.setValueAtTime(Math.max(1, opts.from), start);
      if (opts.to !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), end);
      }

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.gain), start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);

      let tail: AudioNode = osc;
      if (opts.filter) {
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(opts.filter, start);
        tail.connect(filter);
        tail = filter;
      }
      tail.connect(gain);
      gain.connect(master);

      osc.start(start);
      osc.stop(end + 0.03);
    } catch {
      // Half-built audio graphs are not worth crashing a run over.
    }
  }

  private burst(opts: {
    duration: number;
    gain: number;
    from: number;
    to: number;
    delay?: number;
    type?: BiquadFilterType;
  }): void {
    const ctx = this.ctx;
    const master = this.master;
    const buffer = this.noise;
    if (!ctx || !master || !buffer) return;

    try {
      const start = ctx.currentTime + (opts.delay ?? 0);
      const end = start + opts.duration;

      const source = ctx.createBufferSource();
      source.buffer = buffer;

      const filter = ctx.createBiquadFilter();
      filter.type = opts.type ?? 'lowpass';
      filter.frequency.setValueAtTime(Math.max(1, opts.from), start);
      filter.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), end);
      filter.Q.value = 0.8;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(Math.max(0.0002, opts.gain), start);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      source.start(start);
      source.stop(end + 0.03);
    } catch {
      // Same contract as tone(): sound is optional, the game is not.
    }
  }
}
