import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameAudio } from '../src/game/audio';

function parameter() {
  return { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
}
function node() {
  return { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null };
}
function setup() {
  const oscillators: ReturnType<typeof oscillator>[] = [];
  function oscillator() { return { ...node(), frequency: parameter(), type: 'sine' }; }
  const context = {
    state: 'running', currentTime: 0, sampleRate: 48000, destination: {},
    addEventListener: vi.fn(), resume: vi.fn().mockResolvedValue(undefined),
    createGain: () => ({ ...node(), gain: parameter() }),
    createBufferSource: () => ({ ...node(), buffer: null }), createBuffer: vi.fn(),
    decodeAudioData: vi.fn().mockResolvedValue({ duration: .25 }),
    createOscillator: () => { const source = oscillator(); oscillators.push(source); return source; },
  };
  vi.stubGlobal('window', { AudioContext: class { constructor() { return context; } } });
  vi.stubGlobal('document', { hidden: false });
  vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem: vi.fn() });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }));
  const audio = new GameAudio();
  audio.unlock();
  return { audio, context, oscillators };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['performance'] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('countdown warning audio', () => {
  it('starts at ten seconds, ignores duplicate updates, and stops at zero', () => {
    const { audio, oscillators } = setup();
    audio.updateCountdown('turn', 10001); expect(oscillators).toHaveLength(0);
    audio.updateCountdown('turn', 10000); expect(oscillators).toHaveLength(1);
    audio.updateCountdown('turn', 10000); expect(oscillators).toHaveLength(1);
    audio.updateCountdown('turn', 0); expect(oscillators[0].stop).toHaveBeenLastCalledWith();
    audio.updateCountdown('turn', -1); audio.updateCountdown('turn', NaN);
    expect(oscillators).toHaveLength(1);
  });

  it('progressively accelerates without overlapping pulses', () => {
    const { audio, oscillators } = setup();
    const times: number[] = [];
    for (let elapsed = 0; elapsed <= 10000; elapsed += 50) {
      const before = oscillators.length;
      audio.updateCountdown('turn', 10000 - elapsed);
      if (oscillators.length > before) times.push(elapsed);
      vi.advanceTimersByTime(50);
    }
    const intervals = times.slice(1).map((at, i) => at - times[i]);
    expect(intervals[0]).toBe(1000);
    expect(intervals[times.findIndex(at => at >= 2000)]).toBeLessThanOrEqual(600);
    expect(intervals[times.findIndex(at => at >= 7000)]).toBeLessThanOrEqual(150);
    expect(intervals.at(-1)).toBeLessThanOrEqual(150);
    expect(intervals.every((ms, i) => ms >= 150 && (i === 0 || ms <= intervals[i - 1]))).toBe(true);
    expect(oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(880, 0);
    expect(oscillators[0].stop.mock.calls[0][0]).toBeCloseTo(.1);
  });

  it.each(['pause', 'finish', 'closed', 'disconnected', 'stale'])('cancels immediately when %s removes the active clock', () => {
    const { audio, oscillators } = setup();
    audio.updateCountdown('turn', 5000); audio.updateCountdown(null);
    expect(oscillators[0].stop).toHaveBeenLastCalledWith();
    vi.advanceTimersByTime(5000); audio.updateCountdown(null);
    expect(oscillators).toHaveLength(1);
  });

  it('stops on reset and replaces the voice when the turn or deadline changes', () => {
    const { audio, oscillators } = setup();
    audio.updateCountdown('black:deadline1', 4000);
    audio.updateCountdown('white:deadline2', 6000);
    expect(oscillators[0].stop).toHaveBeenLastCalledWith();
    expect(oscillators).toHaveLength(2);
    audio.updateCountdown('white:deadline3', 60000);
    expect(oscillators[1].stop).toHaveBeenLastCalledWith();
    audio.updateCountdown('white:deadline3', 10000);
    expect(oscillators).toHaveLength(3);
  });

  it('mutes immediately and resumes only from the current time', () => {
    const { audio, oscillators } = setup();
    audio.updateCountdown('turn', 10000); audio.setEnabled(false);
    expect(oscillators[0].stop).toHaveBeenLastCalledWith();
    vi.advanceTimersByTime(8000); audio.updateCountdown('turn', 2000);
    expect(oscillators).toHaveLength(1);
    audio.setEnabled(true); audio.updateCountdown('turn', 2000);
    expect(oscillators).toHaveLength(2);
  });

  it('does not replay missed beats after a jump, reconnect, or delayed callback', () => {
    const { audio, oscillators } = setup();
    audio.updateCountdown('turn', 10000);
    vi.advanceTimersByTime(7500); audio.updateCountdown('turn', 2500);
    expect(oscillators).toHaveLength(2);
    audio.updateCountdown('turn', 2500); expect(oscillators).toHaveLength(2);
    audio.stop(); audio.updateCountdown('turn', 2400);
    expect(oscillators).toHaveLength(3);
  });

  it('stops in the background or suspended context and never queues locked audio', () => {
    const { audio, context, oscillators } = setup();
    context.state = 'suspended'; audio.updateCountdown('turn', 9000);
    expect(oscillators).toHaveLength(0);
    context.state = 'running'; audio.updateCountdown('turn', 8000);
    vi.stubGlobal('document', { hidden: true }); audio.updateCountdown('turn', 7900);
    expect(oscillators[0].stop).toHaveBeenLastCalledWith();
    vi.advanceTimersByTime(5000); audio.updateCountdown('turn', 2900);
    expect(oscillators).toHaveLength(1);
    vi.stubGlobal('document', { hidden: false }); audio.updateCountdown('turn', 2800);
    expect(oscillators).toHaveLength(2);
    const locked = new GameAudio(); locked.updateCountdown('turn', 2800);
    expect(oscillators).toHaveLength(2);
  });

  it('cancels the warning without stopping result melodies', () => {
    const { audio, oscillators } = setup();
    audio.play(['win']); audio.updateCountdown('turn', 4000);
    const melody = oscillators.slice(0, 8), warning = oscillators[8];
    audio.updateCountdown(null);
    expect(warning.stop).toHaveBeenLastCalledWith();
    for (const source of melody) expect(source.stop).toHaveBeenCalledTimes(1);
  });
});
