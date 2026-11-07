import type { Snapshot } from './protocol';
import type { Move } from './rules';

export type GameSound = 'start' | 'move' | 'undo' | 'win' | 'lose';
const moveKey = (move: Move) => move.id ?? `${move.x}:${move.y}:${move.color}`;

/** 将权威快照变化转成一次性音效。首次恢复只建立基线，静音时仍消费事件。 */
export class SoundEvents {
  private previous: Snapshot | null = null;
  private seenMoves = new Set<string>();
  private ended = false;

  reset() {
    this.previous = null;
    this.seenMoves.clear();
    this.ended = false;
  }

  // 只在连续观察到开局转换时提示开局；重连、悔棋恢复和旧回包均不重播历史提示。
  /** audible 为 false 时仍更新基线并消费事件，恢复可播放状态后不会补播。 */
  observe(next: Snapshot, audible: boolean): GameSound[] {
    const previous = this.previous;
    const sameRoom = previous?.room === next.room;
    const sameGame = previous?.room === next.room && previous.gameId === next.gameId;
    if (sameRoom && (next.version < previous.version || next.serverNow < previous.serverNow)) return [];
    if (!sameGame) { this.seenMoves.clear(); this.ended = false; }
    // 已撤销棋步的 ID 也保留，避免重复回包重播；同坐标的新 ID 仍视作新落子。
    const added = next.moves.filter(move => !this.seenMoves.has(moveKey(move)));
    const sounds: GameSound[] = [];
    const openingAge = next.turnDeadline === null ? Infinity : next.serverNow - (next.turnDeadline - 60000);
    const startsRound = sameRoom && next.version > previous.version && next.phase === 'running'
      && ((previous.phase === 'waiting' && sameGame && next.round === previous.round)
        || (previous.phase === 'finished' && !sameGame && next.round === previous.round + 1));
    if (startsRound && audible && next.moves.length === 0 && openingAge >= 0 && openingAge <= 2500
      && next.offlineDeadline === null && previous.players.every(player => player.online && player.synced)
      && next.players.every(player => player.online && player.synced)) sounds.push('start');
    if (sameGame && audible) {
      if (next.players.some((player, index) => player.undoLeft < previous.players[index].undoLeft)) sounds.push('undo');
      sounds.push(...added.map(() => 'move' as const));
      if (!this.ended && next.phase === 'finished' && next.winner !== null) {
        sounds.push(next.winner === next.seat ? 'win' : 'lose');
      }
    }
    next.moves.forEach(move => this.seenMoves.add(moveKey(move)));
    this.ended ||= next.phase === 'finished';
    this.previous = next;
    return sounds;
  }
}
