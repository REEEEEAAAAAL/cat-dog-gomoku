import { describe, expect, it } from 'vitest';
import { clockText, outcome, validPoint, winningLine } from '../src/game/rules';
import type { Move, Seat } from '../src/game/rules';

describe('board rules and display', () => {
  it.each([[1, 0, 0, 0], [0, 1, 14, 0], [1, 1, 0, 0], [1, -1, 0, 14]])('finds an edge win %s,%s', (dx, dy, x, y) => {
    const moves: Move[] = Array.from({ length: 5 }, (_, i) => ({ x: x + i * dx, y: y + i * dy, color: 1, seat: 1 }));
    expect(winningLine(moves, moves[4])).toHaveLength(5); expect(outcome(moves, moves[4])).toBe('five');
  });
  it('validates the full draw fixture has no five anywhere', () => {
    const moves: Move[] = Array.from({ length: 225 }, (_, i) => ({ x: i % 15, y: Math.floor(i / 15),
      color: ((Math.floor((i % 15) / 2) + Math.floor(i / 15)) % 2 + 1) as Seat, seat: 1 }));
    expect(moves.every(m => winningLine(moves, m).length === 0)).toBe(true);
    expect(outcome(moves, moves[224])).toBe('draw');
  });
  it('rejects out of bounds and fractional points', () => {
    for (const x of [-1, 15, 1.5, Infinity, NaN]) expect(validPoint({ x, y: 0 })).toBe(false);
    expect(validPoint({ x: 14, y: 14 })).toBe(true);
  });
  it('does not count mixed colors or separated stones', () => {
    const moves: Move[] = [0, 1, 3, 4, 5].map(x => ({ x, y: 0, color: 1, seat: 1 }));
    expect(winningLine(moves, moves[4])).toHaveLength(0);
  });
  it('rounds countdown display up and clamps zero', () => {
    expect(clockText(60000)).toBe('01:00'); expect(clockText(59999)).toBe('01:00');
    expect(clockText(1000)).toBe('00:01'); expect(clockText(-1)).toBe('00:00');
  });
});
