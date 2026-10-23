import type { GameSound } from './sound-events';

type Animal = 'cat' | 'dog';
type Source = AudioBufferSourceNode | OscillatorNode;
const storageKey = 'gomoku.sound';
const melodies = { win: [523.25, 659.25, 783.99, 1046.5], lose: [659.25, 587.33, 523.25, 392] };

export class GameAudio {
  enabled = true;
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private sources = new Set<Source>();
  private buffers = new Map<Animal, Promise<AudioBuffer>>();
  private generation = 0;
  private tail = 0;
  private warned = false;

  constructor() {
    try { this.enabled = localStorage.getItem(storageKey) !== 'off'; }
    catch (error) { this.unavailable(error); }
  }

  private unavailable(error: unknown) {
    if (!this.warned) { console.warn('Game sound unavailable', error instanceof Error ? error.name : 'Audio unavailable'); this.warned = true; }
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.stop();
    try { localStorage.setItem(storageKey, enabled ? 'on' : 'off'); }
    catch (error) { this.unavailable(error); }
  }

  unlock() {
    if (!this.enabled || document.hidden) return;
    try {
      if (!this.context || this.context.state === 'closed') {
        const Audio = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Audio) return;
        this.context = new Audio();
        this.context.addEventListener('statechange', () => { if (this.context?.state !== 'running') this.stop(); });
        this.master = this.context.createGain();
        this.master.gain.value = .55;
        this.master.connect(this.context.destination);
        this.buffers.clear();
      }
      const context = this.context;
      // Resume is called directly in the user gesture, including Safari touch release.
      if (context.state !== 'running') void context.resume().catch(error => this.unavailable(error));
      const silent = context.createBufferSource();
      silent.buffer = context.createBuffer(1, 1, context.sampleRate);
      silent.connect(this.master!); this.track(silent, []); silent.start();
      void this.load('cat').catch(error => this.unavailable(error));
      void this.load('dog').catch(error => this.unavailable(error));
    } catch (error) { this.unavailable(error); }
  }

  stop() {
    this.generation++;
    for (const source of this.sources) {
      try { source.stop(); } catch (error) { this.unavailable(error); }
    }
    this.sources.clear(); this.tail = 0;
  }

  private track(source: Source, nodes: AudioNode[]) {
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect(); nodes.forEach(node => node.disconnect());
    };
  }

  private async load(animal: Animal): Promise<AudioBuffer> {
    let buffer = this.buffers.get(animal);
    if (!buffer) {
      const context = this.context!;
      buffer = fetch(`${import.meta.env.BASE_URL}sounds/${animal}.mp3`)
        .then(response => { if (!response.ok) throw new Error('Sound download failed'); return response.arrayBuffer(); })
        .then(bytes => context.decodeAudioData(bytes));
      this.buffers.set(animal, buffer);
      void buffer.catch(() => { this.buffers.delete(animal); });
    }
    return buffer;
  }

  async animal(animal: Animal) {
    if (!this.enabled || !this.context || document.hidden) return;
    this.stop();
    const generation = this.generation, requested = performance.now();
    try {
      const buffer = await this.load(animal);
      if (!this.enabled || generation !== this.generation || document.hidden || this.context.state !== 'running'
        || performance.now() - requested > 1500) return;
      const source = this.context.createBufferSource();
      source.buffer = buffer; source.connect(this.master!);
      this.track(source, []); source.start();
    } catch (error) { this.unavailable(error); }
  }

  play(sounds: readonly GameSound[]) {
    if (!sounds.length || !this.enabled || document.hidden || this.context?.state !== 'running') return;
    try {
      const context = this.context;
      let at = Math.max(context.currentTime + .012, this.tail);
      for (const sound of sounds) {
        if (sound === 'move') {
          // Damped wood resonances and a filtered impact avoid a sharp electronic beep.
          this.tone(510, at, .085, .22, 'sine', 340);
          this.tone(870, at, .045, .085, 'sine', 680);
          this.noise(at, .036, .24, 1800, 1100, 'lowpass');
          at += .14;
        } else if (sound === 'undo') {
          this.noise(at, .23, .28, 3100, 420, 'bandpass');
          at += .27;
        } else {
          melodies[sound].forEach((frequency, index) => {
            const duration = index === 3 ? .33 : .13;
            this.tone(frequency, at + index * .145, duration, .17, 'triangle');
            this.tone(frequency * 2, at + index * .145, duration * .7, .022, 'sine');
          });
          at += .81;
        }
      }
      this.tail = at;
    } catch (error) { this.stop(); this.unavailable(error); }
  }

  private envelope(at: number, duration: number, volume: number) {
    const gain = this.context!.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(volume, at + Math.min(.008, duration / 4));
    gain.gain.exponentialRampToValueAtTime(.0001, at + duration);
    gain.gain.linearRampToValueAtTime(0, at + duration + .008);
    gain.connect(this.master!);
    return gain;
  }

  private tone(frequency: number, at: number, duration: number, volume: number, type: OscillatorType, end = frequency) {
    const source = this.context!.createOscillator(), gain = this.envelope(at, duration, volume);
    source.type = type; source.frequency.setValueAtTime(frequency, at);
    source.frequency.exponentialRampToValueAtTime(end, at + duration);
    source.connect(gain); this.track(source, [gain]);
    source.start(at); source.stop(at + duration + .01);
  }

  private noise(at: number, duration: number, volume: number, from: number, to: number, type: BiquadFilterType) {
    const context = this.context!, buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const source = context.createBufferSource(), filter = context.createBiquadFilter(), gain = this.envelope(at, duration, volume);
    source.buffer = buffer; filter.type = type; filter.Q.value = .7;
    filter.frequency.setValueAtTime(from, at); filter.frequency.exponentialRampToValueAtTime(to, at + duration);
    source.connect(filter); filter.connect(gain); this.track(source, [filter, gain]); source.start(at);
  }
}
