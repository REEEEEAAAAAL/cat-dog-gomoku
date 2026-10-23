import { describe, expect, it } from 'vitest';
import { SoundEvents } from '../src/game/sound-events';
import type { Snapshot } from '../src/game/protocol';
import type { Move } from '../src/game/rules';

const player = { name: '朋友', animal: 'cat' as const, ready: true, online: true, synced: true, undoLeft: 2 };
const move = (id: string, x = 7): Move => ({ id, x, y: 7, seat: 1, color: 1 });
function state(extra: Partial<Snapshot> = {}): Snapshot {
  return { pending: false, room: 'room', code: '1234567890', seat: 1, version: 1, gameId: 'round-1', round: 1,
    phase: 'running', blackSeat: 1, turnSeat: 1, moves: [], winLine: [], winner: null, reason: null,
    players: [{ ...player }, { ...player }], application: null, remainingMs: 60000, turnDeadline: 60000,
    offlineDeadline: null, serverNow: 0, expiresAt: 86400000, accepted: true, rejection: null, duplicate: false,
    undoRequest: null, emojis: [], ...extra };
}

describe('confirmed snapshot sound events', () => {
  it('keeps the first restored board and finished result silent', () => {
    for (const phase of ['running', 'finished'] as const) {
      const events = new SoundEvents(), restored = state({ moves: [move('old')], phase, winner: phase === 'finished' ? 1 : null });
      expect(events.observe(restored, true)).toEqual([]);
      expect(events.observe({ ...restored, serverNow: 5000 }, true)).toEqual([]);
    }
  });
  it('plays each confirmed move once on either seat, including a duplicate operation receipt', () => {
    for (const seat of [1, 2] as const) {
      const events = new SoundEvents(); events.observe(state({ seat }), true);
      const next = state({ seat, version: 2, moves: [move('a')] });
      expect(events.observe(next, true)).toEqual(['move']);
      expect(events.observe({ ...next, duplicate: true }, true)).toEqual([]);
      expect(events.observe({ ...next, serverNow: 5000, accepted: false, rejection: 'state_conflict' }, true)).toEqual([]);
    }
  });
  it('does not sound for request, refusal, withdrawal, expiry, emoji or unchanged polling', () => {
    const events = new SoundEvents(), base = state({ moves: [move('a')] }); events.observe(base, true);
    const request = { id: 'undo', seat: 1 as const, target: 'a', removeCount: 1 as const, restoreMs: 60000, expiresAt: 30000 };
    expect(events.observe({ ...base, version: 2, phase: 'paused', undoRequest: request }, true)).toEqual([]);
    expect(events.observe({ ...base, version: 3, undoDenied: { id: 'undo', target: 'a', at: 1 } }, true)).toEqual([]);
    expect(events.observe({ ...base, version: 4, emojis: [{ id: 'emoji', seat: 1, emoji: 'heart', at: 1 }] }, true)).toEqual([]);
    expect(events.observe({ ...base, version: 5, serverNow: 30000 }, true)).toEqual([]);
  });
  it('sounds once for confirmed undo even when replacement moves keep the same board size', () => {
    const events = new SoundEvents(), base = state({ moves: [move('a')] }); events.observe(base, true);
    const undo = state({ version: 2, moves: [move('b')], players: [{ ...player, undoLeft: 1 }, { ...player }] });
    expect(events.observe(undo, true)).toEqual(['undo', 'move']);
    expect(events.observe(undo, true)).toEqual([]);
  });
  it('allows a new move ID at an undone coordinate without replaying removed IDs', () => {
    const events = new SoundEvents(); events.observe(state({ moves: [move('a')] }), true);
    const players: Snapshot['players'] = [{ ...player, undoLeft: 1 }, { ...player }];
    expect(events.observe(state({ version: 2, moves: [], players }), true)).toEqual(['undo']);
    expect(events.observe(state({ version: 3, moves: [move('b')], players }), true)).toEqual(['move']);
  });
  it.each(['five', 'timeout'] as const)('plays opposite results for %s and sequences a final move first', reason => {
    for (const seat of [1, 2] as const) {
      const events = new SoundEvents(); events.observe(state({ seat }), true);
      const next = state({ seat, phase: 'finished', winner: 1, reason, version: 2, moves: reason === 'five' ? [move('last')] : [] });
      expect(events.observe(next, true)).toEqual([...(reason === 'five' ? ['move'] : []), seat === 1 ? 'win' : 'lose']);
      expect(events.observe({ ...next, version: 3 }, true)).toEqual([]);
    }
  });
  it.each(['draw', 'disconnect_timeout', 'left'] as const)('keeps a result without a winner silent: %s', reason => {
    const events = new SoundEvents(); events.observe(state(), true);
    expect(events.observe(state({ phase: reason === 'left' ? 'closed' : 'finished', winner: null, reason, version: 2 }), true)).toEqual([]);
  });
  it('consumes muted, disconnected and background events without replay on resume', () => {
    const events = new SoundEvents(); events.observe(state(), true);
    const missed = state({ version: 2, moves: [move('a')], phase: 'finished', winner: 1, reason: 'five' });
    expect(events.observe(missed, false)).toEqual([]);
    expect(events.observe({ ...missed, serverNow: 20000 }, true)).toEqual([]);
  });
  it('ignores stale replies and starts a fresh silent baseline for a new round or room', () => {
    const events = new SoundEvents(); events.observe(state({ version: 5, moves: [move('a')] }), true);
    expect(events.observe(state({ version: 4 }), true)).toEqual([]);
    expect(events.observe(state({ version: 6, moves: [move('a'), move('b', 8)] }), true)).toEqual(['move']);
    expect(events.observe(state({ room: 'other', gameId: 'round-2', moves: [move('c')] }), true)).toEqual([]);
    events.reset();
    expect(events.observe(state({ phase: 'finished', winner: 1 }), true)).toEqual([]);
  });
});
