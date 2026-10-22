export const BOARD_SIZE = 15;
export type Seat = 1 | 2;
export interface Point { x: number; y: number }
export interface Move extends Point { seat: Seat; color: Seat; remainingMs?: number }

export function validPoint(point: Point): boolean {
  return Number.isInteger(point.x) && Number.isInteger(point.y)
    && point.x >= 0 && point.x < BOARD_SIZE && point.y >= 0 && point.y < BOARD_SIZE;
}

export function winningLine(moves: readonly Move[], last: Move): Point[] {
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    const line: Point[] = [{ x: last.x, y: last.y }];
    for (const sign of [-1, 1]) {
      let x = last.x + sign * dx;
      let y = last.y + sign * dy;
      while (validPoint({ x, y }) && moves.some(m => m.x === x && m.y === y && m.color === last.color)) {
        line.push({ x, y }); x += sign * dx; y += sign * dy;
      }
    }
    if (line.length >= 5) return line;
  }
  return [];
}

export function outcome(moves: readonly Move[], last: Move): 'five' | 'draw' | null {
  return winningLine(moves, last).length ? 'five' : moves.length === 225 ? 'draw' : null;
}

export function clockText(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function createId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
