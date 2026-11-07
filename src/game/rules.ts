export const BOARD_SIZE = 15;
export type Seat = 1 | 2;
export interface Point { x: number; y: number }
// color 固定为 1 黑、2 白；seat 是玩家席位，跨局交换棋色时两者不一定相等。
export interface Move extends Point { id?: string; seat: Seat; color: Seat; remainingMs?: number }

export function validPoint(point: Point): boolean {
  return Number.isInteger(point.x) && Number.isInteger(point.y)
    && point.x >= 0 && point.x < BOARD_SIZE && point.y >= 0 && point.y < BOARD_SIZE;
}

/** 基于合法棋步和末手沿四条轴双向延伸，返回首条至少五子的完整连线；无禁手。 */
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

// 必须先判断连五，避免最后一个空位形成胜利时被满盘规则判成和棋。
export function outcome(moves: readonly Move[], last: Move): 'five' | 'draw' | null {
  return winningLine(moves, last).length ? 'five' : moves.length === 225 ? 'draw' : null;
}

// 向上取整使剩余不足一秒仍显示 00:01，零点裁决由服务端完成。
export function clockText(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** 生成请求和房间使用的 UUID；缺少 randomUUID 时仍使用加密随机数并设置 v4 标志。 */
export function createId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
