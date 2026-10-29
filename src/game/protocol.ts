import type { Move, Point, Seat } from './rules';
import type { ChatSnapshot } from './chat-protocol';
import { isChatSnapshot } from './chat-protocol';

export type Phase = 'waiting' | 'running' | 'paused' | 'finished' | 'closed';
export type Action = 'create' | 'apply' | 'connect' | 'snapshot' | 'sync' | 'approve' | 'reject' | 'ready' | 'move' | 'rematch' | 'leave'
  | 'resign' | 'undo_request' | 'undo_respond' | 'undo_cancel' | 'emoji' | 'withdraw' | 'preview';
export interface InvitationInfo { preview: true; room: string; code: string; animal: 'cat' | 'dog' }
export function isInvitationInfo(value: unknown): value is InvitationInfo {
  return typeof value === 'object' && value !== null && 'preview' in value && value.preview === true
    && 'room' in value && typeof value.room === 'string' && 'code' in value && typeof value.code === 'string'
    && 'animal' in value && (value.animal === 'cat' || value.animal === 'dog');
}
export const reactions = { cat: '😼', dog: '🐶', heart: '❤️', plead: '🥺', cry: '😭', angry: '😤', laugh: '😂', celebrate: '🎉' } as const;
export type Reaction = keyof typeof reactions;
export interface ReactionEvent { id: string; seat: Seat; emoji: Reaction; at: number }
export interface UndoRequest { id: string; seat: Seat; target: string; removeCount: 1 | 2; restoreMs: number; expiresAt: number }
export interface Player { name: string; animal: 'dog' | 'cat'; ready: boolean; online: boolean; synced: boolean; undoLeft: number }
export interface Pending { pending: true; room: string; code: string; serverNow: number; applicationId: string | null; withdrawn?: boolean }
export interface Snapshot {
  chat?: ChatSnapshot;
  pending: false;
  room: string;
  code: string;
  seat: Seat;
  version: number;
  gameId: string;
  round: number;
  phase: Phase;
  blackSeat: Seat;
  turnSeat: Seat;
  moves: Move[];
  winLine: Point[];
  winner: Seat | null;
  reason: 'resign' | 'five' | 'draw' | 'timeout' | 'disconnect_timeout' | 'left' | null;
  players: [Player, Player];
  application: { id: string; name: string } | null;
  remainingMs: number;
  turnDeadline: number | null;
  offlineDeadline: number | null;
  serverNow: number;
  expiresAt: number;
  accepted: boolean;
  rejection: string | null;
  duplicate: boolean;
  undoRequest: UndoRequest | null;
  emojis: ReactionEvent[];
  undoDenied?: { id: string; target: string; at: number } | null;
  undoBlocked?: boolean;
}
export type Reply = Pending | Snapshot;
export interface Command {
  p_room: string;
  p_action: Action;
  p_client: string;
  p_operation: string | null;
  p_version: number | null;
  p_game: string | null;
  p_data: Record<string, unknown>;
  p_protocol: 1;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';
const seat = (value: unknown): value is Seat => value === 1 || value === 2;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nullableNumber = (value: unknown) => value === null || number(value);
const point = (value: unknown): value is Point => object(value) && number(value.x) && number(value.y)
  && Number.isInteger(value.x) && Number.isInteger(value.y) && value.x >= 0 && value.x < 15 && value.y >= 0 && value.y < 15;
const player = (value: unknown): value is Player => object(value) && typeof value.name === 'string'
  && (value.animal === 'cat' || value.animal === 'dog') && typeof value.ready === 'boolean'
  && typeof value.online === 'boolean' && typeof value.synced === 'boolean' && number(value.undoLeft) && value.undoLeft >= 0 && value.undoLeft <= 2;

export function isReply(value: unknown): value is Reply {
  if (!object(value) || typeof value.room !== 'string' || typeof value.code !== 'string' || !number(value.serverNow)) return false;
  if (value.pending === true) return value.withdrawn === true ? value.applicationId === null : typeof value.applicationId === 'string';
  return value.pending === false && (value.chat === undefined || (isChatSnapshot(value.chat) && value.chat.room === value.room))
    && seat(value.seat) && number(value.version) && typeof value.gameId === 'string'
    && number(value.round) && ['waiting', 'running', 'paused', 'finished', 'closed'].includes(String(value.phase))
    && seat(value.blackSeat) && seat(value.turnSeat) && Array.isArray(value.moves) && value.moves.length <= 225
    && value.moves.every(m => point(m) && object(m) && seat(m.seat) && seat(m.color))
    && Array.isArray(value.winLine) && value.winLine.every(point) && (value.winner === null || seat(value.winner))
    && [null, 'resign', 'five', 'draw', 'timeout', 'disconnect_timeout', 'left'].includes(value.reason as string | null)
    && Array.isArray(value.players) && value.players.length === 2 && value.players.every(player)
    && (value.application === null || (object(value.application) && typeof value.application.id === 'string' && typeof value.application.name === 'string'))
    && number(value.remainingMs) && nullableNumber(value.turnDeadline) && nullableNumber(value.offlineDeadline)
    && number(value.expiresAt) && typeof value.accepted === 'boolean'
    && (value.rejection === null || typeof value.rejection === 'string') && typeof value.duplicate === 'boolean'
    && (value.undoRequest === null || (object(value.undoRequest) && typeof value.undoRequest.id === 'string'
      && seat(value.undoRequest.seat) && typeof value.undoRequest.target === 'string'
      && [1, 2].includes(Number(value.undoRequest.removeCount)) && number(value.undoRequest.restoreMs)
      && number(value.undoRequest.expiresAt)))
    && (value.undoBlocked === undefined || typeof value.undoBlocked === 'boolean')
    && (value.undoDenied === undefined || value.undoDenied === null || (object(value.undoDenied)
      && typeof value.undoDenied.id === 'string' && typeof value.undoDenied.target === 'string' && number(value.undoDenied.at)))
    && Array.isArray(value.emojis) && value.emojis.length <= 20 && value.emojis.every(e => object(e)
      && typeof e.id === 'string' && seat(e.seat) && typeof e.emoji === 'string' && Object.hasOwn(reactions, e.emoji) && number(e.at));
}

const messages: Record<string, string> = {
  invalid_chat: '请输入 1～100 字的非空白文字', chat_rate_limit: '发送过快，请稍后重试（每 2 秒一条，每分钟最多 10 条）',
  chat_id_conflict: '消息编号冲突，请重新进入房间核对',
  not_found: '没有找到房间，请核对房间码', expired: '房间已过期，请重新创建', room_full: '房间已有两位玩家',
  forbidden: '尚未获得房间访问权限，请重新申请加入', unauthorized: '登录已失效，请重新连接',
  application_pending: '已有一位玩家申请加入，请稍后再试', invalid_name: '昵称请输入 1～12 个字符',
  superseded: '此房间已在另一个页面打开，请关闭重复页面或点击重新连接',
  state_conflict: '状态已更新，请核对棋盘后重新操作', old_game: '上一局已结束，请核对新棋盘',
  not_your_turn: '请等待对方落子', occupied: '这个位置已有棋子', not_running: '对局尚未开始或计时已暂停',
  opponent_offline: '等待对方恢复连接并同步', sync_required: '正在同步，请稍后操作',
  room_closed: '房间已关闭，请创建新房间', create_limit: '创建太频繁，请稍后重试或继续已有房间',
  invalid_position: '请选择棋盘上的空交叉点', wrong_phase: '当前状态无法执行此操作',
  application_changed: '加入申请已变化，请核对后重试', protocol_mismatch: '网页版本已更新，请刷新',
  undo_limit: '本局两次悔棋机会已用完', no_undo_move: '你还没有落子，暂时不能悔棋',
  undo_target_changed: '最近棋步已变化，请重新核对悔棋范围', undo_already_requested: '你本轮申请过但是失败了，下次再试试吧~',
  undo_cooldown: '请等上次申请满 30 秒后再试', undo_expired: '悔棋申请已结束或过期',
  invalid_emoji: '请选择提供的表情', emoji_rate_limit: '表情发得太快啦，稍等一下',
  connect_required: '正在同步房间身份',
};
export function errorMessage(code: string): string {
  return messages[code] ?? '服务端未确认操作，请重试连接';
}

export class RpcError extends Error {
  constructor(readonly code: string) { super(errorMessage(code)); this.name = 'RpcError'; }
}

export function rpcError(body: unknown): RpcError {
  const message = object(body) && typeof body.message === 'string' ? body.message : '';
  const code = Object.keys(messages).find(code => message.split(/[^a-z_]+/).includes(code));
  return new RpcError(code ?? 'unavailable');
}
