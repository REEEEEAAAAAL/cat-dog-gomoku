import type { Snapshot } from './protocol';
import type { Move } from './rules';

export type GameSound = 'start' | 'move' | 'undo' | 'win' | 'lose';
const moveKey = (move: Move) => move.id ?? `${move.x}:${move.y}:${move.color}`;

export class SoundEvents {
  private previous: Snapshot | null = null;
  private seenMoves = new Set<string>();
  private ended = false;

  reset() {
    this.previous = null;
    this.seenMoves.clear();
    this.ended = false;
  }

  observe(next: Snapshot, audible: boolean): GameSound[] {
    const previous = this.previous;
    const sameRoom = previous?.room === next.room;
    const sameGame = previous?.room === next.room && previous.gameId === next.gameId;
    if (sameRoom && (next.version < previous.version || next.serverNow < previous.serverNow)) return [];
    if (!sameGame) { this.seenMoves.clear(); this.ended = false; }
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
