import './style.css';
import { avatar } from './avatars';
import { login, send, inspectInvitation } from './api';
import { clockText, createId } from './rules';
import type { Point } from './rules';
import { errorMessage, reactions, RpcError } from './protocol';
import type { Action, Command, Reaction, Reply, Snapshot, InvitationInfo } from './protocol';
import { GameAudio } from './audio';
import { SoundEvents } from './sound-events';

const el = (id: string) => document.getElementById(id)!;
const button = (id: string) => el(id) as HTMLButtonElement;
const input = (id: string) => el(id) as HTMLInputElement;
const audio = new GameAudio();
const soundEvents = new SoundEvents();
function renderSound() {
  button('sound').setAttribute('aria-pressed', String(audio.enabled));
  button('sound').setAttribute('aria-label', audio.enabled ? '关闭声音' : '开启声音');
  button('sound').title = audio.enabled ? '关闭声音' : '开启声音';
}
button('sound').onclick = () => { audio.setEnabled(!audio.enabled); renderSound(); if (audio.enabled) audio.unlock(); };
for (const event of ['pointerup', 'keydown', 'click'] as const) document.addEventListener(event, event => {
  if (event.isTrusted) audio.unlock();
}, { capture: true, passive: true });
window.addEventListener('storage', event => {
  if (event.key === 'gomoku.sound') { audio.setEnabled(event.newValue !== 'off'); renderSound(); }
});
renderSound();
const compactLayout = window.matchMedia('(max-width:760px)');
const desktopLayout = window.matchMedia('(min-width:900px)');
function positionDesktopActions() {
  const panel = el('desktopActions');
  panel.hidden = !desktopLayout.matches;
  el('roomAside').insertBefore(el('rules'), panel);
  if (desktopLayout.matches) {
    for (const id of ['interactionControls', 'moveControls', 'leave']) panel.appendChild(el(id));
  } else {
    el('boardArea').appendChild(el('moveControls'));
    el('mobileActions').appendChild(el('interactionControls'));
    el('roomAside').insertBefore(el('rules'), panel);
    el('roomAside').insertBefore(el('leave'), panel);
  }
}
desktopLayout.addEventListener('change', positionDesktopActions);
positionDesktopActions();
button('previousReactions').onclick = () => el('reactions').scrollBy({ left:-(el('reactions').clientWidth + 3), behavior:'smooth' });
button('nextReactions').onclick = () => el('reactions').scrollBy({ left:el('reactions').clientWidth + 3, behavior:'smooth' });
if (typeof CSS !== 'undefined' && typeof CSS.registerProperty === 'function') document.documentElement.classList.add('smooth-turn');
const client = createId();
const roomPattern = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{10})$/i;
let storedRoom = localStorage.getItem('gomoku.room') || '';
const invitation = location.hash.slice(1);
let animal: 'dog' | 'cat' = 'cat';
let invited = false;
let invitationInfo: InvitationInfo | null = null;
let room = '';
let snapshot: Snapshot | null = null;
let pending = false;
let applicationId: string | null = null;
let busy = false;
let polling = false;
let connected = false;
let superseded = false;
let selection: Point | null = null;
let lastReceiptAt = 0;
let serverAtReceipt = 0;
let epoch = 0;
let uncertain: Command | null = null;
let lastStatus = '';
const cells: HTMLButtonElement[] = [];
const seenReactions = new Set<string>();
const bubbles = new Map<number, { reaction: Reaction; until: number }>();
let undoTarget = '';
let undoProposal: Pick<Snapshot, 'version' | 'gameId'> | null = null;
let resignGame: string | null = null;
let resultKey = '';
let dismissedResult = '';
let replayStep: number | null = null;
let showReplayNumbers = true;
let feedbackTimer = 0;
let lastActivityAt = performance.now();
let idlePaused = false;

function feedback(message: string, error = false) {
  window.clearTimeout(feedbackTimer);
  el('feedbackText').textContent = message;
  el('feedback').hidden = false;
  el('feedback').classList.toggle('error', error);
  feedbackTimer = window.setTimeout(() => { el('feedback').hidden = true; }, 9000);
}

function forgetRoom(target = room) {
  if (storedRoom === target) { storedRoom = ''; localStorage.removeItem('gomoku.room'); }
}

function home() {
  soundEvents.reset(); audio.stop();
  epoch++; room = ''; pending = false; snapshot = null; connected = false; superseded = false;
  selection = null; uncertain = null; applicationId = null; bubbles.clear(); seenReactions.clear();
  resultKey = ''; dismissedResult = ''; replayStep = null; el('feedback').hidden = true;
  idlePaused = false;
  document.querySelectorAll<HTMLDialogElement>('dialog').forEach(dialog => dialog.close());
  history.replaceState(null, '', location.pathname); el('copyFallback').hidden = true;
  el('entryTitle').textContent = 'Hello，你是谁？'; render();
}

function failure(error: unknown) {
  const wasPending = pending;
  connected = false; selection = null;
  const message = error instanceof Error ? error.message : '连接失败，稍后会自动重试';
  superseded = error instanceof RpcError && error.code === 'superseded';
  const terminal = error instanceof RpcError && ['not_found', 'expired', 'room_full', 'room_closed', 'forbidden',
    'application_pending', 'invalid_name', 'create_limit'].includes(error.code);
  if (terminal && (!uncertain || ['not_found', 'expired', 'room_closed'].includes(error.code))) {
    if (['not_found', 'expired', 'room_closed'].includes(error.code)) {
      forgetRoom(); sessionStorage.removeItem(`gomoku.operation.${room}`);
    }
    home();
    notice(wasPending && error.code === 'forbidden' ? '加入申请已结束。如需加入，请重新申请。' : message, true);
    return;
  }
  notice(uncertain ? `${message}。上次操作结果未知，请重试核对，避免重复落子。` : message, true);
}

function notice(message: string, error = false) {
  if (lastStatus !== message) { el('notice').textContent = message; lastStatus = message; }
  el('connectionDot').className = `connection-dot ${error ? 'error' : connected ? 'online' : ''}`;
}

function canResign() {
  return !!snapshot && ['running', 'paused'].includes(snapshot.phase) && connected && !busy && !uncertain
    && snapshot.players[snapshot.seat - 1].synced && !document.hidden && performance.now() - lastReceiptAt < 15000;
}

function canMove() {
  return replayStep === null && !!snapshot && snapshot.phase === 'running' && snapshot.turnSeat === snapshot.seat
    && snapshot.players.every(p => p.online && p.synced) && connected && !busy && !uncertain
    && !document.hidden && performance.now() - lastReceiptAt < 15000
    && snapshot.turnDeadline !== null && snapshot.turnDeadline > serverAtReceipt + performance.now() - lastReceiptAt;
}

function renderClock() {
  const s = snapshot;
  if (!s) return;
  const now = serverAtReceipt + performance.now() - lastReceiptAt;
  const ms = s.phase === 'running' && s.turnDeadline !== null ? Math.max(0, s.turnDeadline - now)
    : s.phase === 'finished' && s.reason === 'five' ? s.moves.at(-1)?.remainingMs ?? s.remainingMs : s.remainingMs;
  el('clock').textContent = s.phase === 'waiting' ? '01:00' : clockText(ms);
  el('clock').classList.toggle('urgent', s.phase === 'running' && ms <= 10000);
  if (s.phase === 'paused' && s.offlineDeadline !== null) {
    el('turnHint').textContent = `计时已暂停 · 等待恢复 ${clockText(s.offlineDeadline - now)}`;
  } else if (s.phase === 'running' && ms === 0) {
    el('turnHint').textContent = '时间到，等待服务端裁决';
    button('confirm').disabled = true;
  }
  if (s.undoRequest) {
    el('undoCountdown').textContent = `等待回应 ${clockText(s.undoRequest.expiresAt - now)}`;
    if (s.offlineDeadline === null) el('turnHint').textContent = '悔棋协商中，计时已暂停';
  }
  if (s.phase !== 'closed' && performance.now() - lastReceiptAt >= 15000 && connected) {
    connected = false; selection = null; render(); notice('正在重新同步，暂时不能落子', true);
  }
  for (const [seat, bubble] of bubbles) {
    if (performance.now() >= bubble.until) { bubbles.delete(seat); document.querySelector(`[data-bubble-seat="${seat}"]`)?.remove(); }
  }
}

function playerElements(s: Snapshot) {
  el('opponentPlayer').replaceChildren(); el('selfPlayer').replaceChildren();
  for (let index = 0; index < 2; index++) {
    const p = s.players[index]; const seat = index + 1;
    const container = el(seat === s.seat ? 'selfPlayer' : 'opponentPlayer');
    const node = document.createElement('div');
    node.className = `player ${s.phase === 'running' && s.turnSeat === seat ? 'active' : ''}`;
    node.innerHTML = `${avatar(p.animal)}<div class="player-info"><span class="player-name"></span><span class="player-detail"><i class="color-dot ${s.blackSeat === seat ? '' : 'white'}"></i><span></span></span></div>`;
    if (s.phase === 'running' && s.turnSeat === seat) {
      node.style.setProperty('--turn-phase', `${-(performance.now() / 1000 % 2)}s`);
      node.insertAdjacentHTML('beforeend', '<span class="turn-orbit" aria-hidden="true"></span>');
    }
    node.querySelector('.player-name')!.textContent = p.name ? `${p.name}${seat === s.seat ? '（你）' : '（对方）'}` : '等待对方入座';
    node.querySelector('.player-detail span')!.textContent = `${s.blackSeat === seat ? '黑棋' : '白棋'} · ${!p.name ? '未加入' : !p.online ? '离线' : !p.synced ? '同步中' : p.ready ? '已准备' : '在线'} · 悔棋：剩余${p.undoLeft}次`;
    const bubble = bubbles.get(seat);
    if (bubble && performance.now() < bubble.until) {
      const emoji = document.createElement('span'); emoji.className = 'reaction-bubble';
      emoji.dataset.bubbleSeat = String(seat); emoji.textContent = reactions[bubble.reaction];
      emoji.setAttribute('role', 'img'); emoji.setAttribute('aria-label', '对局表情'); node.appendChild(emoji);
    }
    container.appendChild(node);
  }
}

function renderBoard() {
  const s = snapshot;
  const moves = replayStep === null ? s?.moves : s?.moves.slice(0, replayStep);
  const replaying = replayStep !== null;
  el('board').classList.toggle('replaying', replaying);
  const map = new Map(moves?.map((m, i) => [`${m.x},${m.y}`, { ...m, number: i + 1, last: i === moves.length - 1 }]));
  for (let i = 0; i < cells.length; i++) {
    const x = i % 15, y = Math.floor(i / 15), cell = cells[i];
    const move = map.get(`${x},${y}`);
    const preview = !move && selection?.x === x && selection.y === y;
    const color = move?.color ?? (s?.seat === s?.blackSeat ? 1 : 2);
    const mark = move?.last ? replaying ? 'replay-current' : 'last' : '';
    const number = replaying && showReplayNumbers && move ? `<span class="stone-number" data-digits="${String(move.number).length}">${move.number}</span>` : '';
    cell.innerHTML = move || preview ? `<span class="stone ${color === 2 ? 'white' : ''} ${mark} ${preview ? 'preview' : ''}">${number}</span>` : '';
    cell.setAttribute('aria-label', `${String.fromCharCode(65 + x)}${y + 1}${move ? color === 1 ? ' 黑棋' : ' 白棋' : ' 空位'}${replaying && move ? ` 第 ${move.number} 手` : ''}${preview ? ' 已选' : ''}`);
    cell.setAttribute('aria-disabled', String(!!move || !canMove()));
  }
  const line = replayStep === null || replayStep === s?.moves.length ? s?.winLine : null;
  if (line?.length) {
    const sorted = [...line].sort((a, b) => a.x - b.x || a.y - b.y);
    const first = sorted[0], last = sorted[sorted.length - 1];
    el('winOverlay').innerHTML = `<line x1="${first.x + .5}" y1="${first.y + .5}" x2="${last.x + .5}" y2="${last.y + .5}" stroke="#b46f40" stroke-width=".12" stroke-linecap="round"/>`;
  } else el('winOverlay').replaceChildren();
}

function renderReplay() {
  const s = snapshot;
  el('replayArea').hidden = s?.phase !== 'finished';
  const active = replayStep !== null;
  button('reviewGame').hidden = active;
  el('replayTimeline').hidden = !active;
  el('replayDetails').style.visibility = active ? 'visible' : 'hidden';
  button('toggleReplayNumbers').textContent = showReplayNumbers ? '隐藏步数' : '显示步数';
  button('toggleReplayNumbers').setAttribute('aria-pressed', String(showReplayNumbers));
  if (!s || replayStep === null) return;
  const total = s.moves.length;
  input('replayProgress').max = String(total);
  input('replayProgress').value = String(replayStep);
  input('replayProgress').disabled = total === 0;
  el('replayCount').textContent = `第 ${replayStep} / ${total} 手`;
  const move = s.moves[replayStep - 1];
  el('replayMove').textContent = move ? `${s.players[move.seat - 1].animal === 'cat' ? '猫猫' : '狗狗'} · ${move.color === 1 ? '黑棋' : '白棋'}` : total ? '开局 · 空棋盘' : '本局尚未落子';
  input('replayProgress').setAttribute('aria-valuetext', `${el('replayCount').textContent}，${el('replayMove').textContent}`);
  for (const id of ['replayStart', 'replayPrevious']) button(id).disabled = replayStep === 0;
  for (const id of ['replayNext', 'replayEnd']) button(id).disabled = replayStep === total;
}

function seekReplay(step: number) {
  if (snapshot?.phase !== 'finished' || replayStep === null || !Number.isFinite(step)) return;
  replayStep = Math.max(0, Math.min(snapshot.moves.length, Math.trunc(step)));
  renderReplay(); renderBoard();
}

function positionLobby() {
  const target = el(compactLayout.matches && snapshot?.phase === 'waiting' ? 'readySlot' : 'lobbySlot');
  if (el('lobbyPanel').parentElement !== target) target.appendChild(el('lobbyPanel'));
}
compactLayout.addEventListener('change', positionLobby);

function render() {
  positionLobby();
  el('entryPanel').classList.toggle('invited', invited);
  el('joinTitle').hidden = !invited;
  el('invitationRole').hidden = !invited;
  el('identityPicker').hidden = invited && !invitationInfo;
  el('invitationRole').textContent = invitationInfo ? `房间剩余角色：${invitationInfo.animal === 'cat' ? '猫猫' : '狗狗'}，已为你选好。` : busy ? '正在确认房间剩余角色…' : '暂时无法确认房间角色，请重试。';
  button('retryInvitation').hidden = !invited || !!invitationInfo || busy;
  for (const value of ['dog', 'cat'] as const) {
    button(value).hidden = invited && invitationInfo?.animal !== value;
    button(value).disabled = invited && invitationInfo?.animal !== value;
  }
  button('create').textContent = invited ? '改为创建房间' : '创建房间';
  el('home').hidden = !!room;
  el('room').hidden = !room;
  const s = snapshot;
  document.querySelector<HTMLElement>('.play-area')!.hidden = pending || !s;
  el('pendingPanel').hidden = !pending;
  el('lobbyPanel').hidden = !s || s.phase === 'running' || s.phase === 'paused';
  el('invitePanel').hidden = !s || s.phase === 'closed' || (connected && s.players.every(p => p.name && p.online));
  el('applicationPanel').hidden = !s?.application;
  button('reconnect').hidden = !room || busy || s?.phase === 'closed' || (connected && !superseded);
  button('retry').hidden = !uncertain || busy;
  button('create').disabled = busy;
  button('join').disabled = busy || (invited && !invitationInfo);
  button('resume').hidden = !roomPattern.test(storedRoom);
  button('cancelApplication').disabled = busy;
  button('homeReturn').hidden = !s || s.phase !== 'closed';
  button('leave').hidden = !s || s.phase === 'closed';
  if (!s) return;
  el('round').textContent = String(s.round).padStart(2, '0');
  el('roomCode').textContent = s.code;
  playerElements(s);
  const own = s.players[s.seat - 1];
  const turnName = s.players[s.turnSeat - 1].name;
  const winner = s.winner ? s.players[s.winner - 1].name : '';
  let title: string;
  let text: string;
  if (s.phase === 'running') {
    title = s.turnSeat === s.seat ? '你的回合！' : `${turnName}的回合`; text = s.turnSeat === s.seat ? '轮到你了，选一个空交叉点' : '等对方想一想，下一步就到你';
  } else if (s.phase === 'paused') {
    title = s.undoRequest ? '悔棋请求待处理' : '等你们重新连上';
    text = s.undoRequest ? '等对方回应，双方暂时不能落子。' : '棋盘已保存。双方恢复连接并同步后，继续剩余时间。';
  } else if (s.phase === 'waiting') {
    title = s.players[1].name ? '都准备好，开一局！' : '等另一个人来ing...'; text = '分享邀请链接，房主确认加入后，双方点击准备。';
  } else if (s.phase === 'closed') {
    title = '房间已关闭'; text = '本房间不能继续，可以返回首页再建一间。';
  } else {
    title = s.reason === 'draw' ? '这一局，平分秋色' : s.reason === 'disconnect_timeout' ? '本局已中止，不计输赢' : `${winner}获胜！🎉`;
    text = s.reason === 'resign' ? (s.winner === s.seat ? '对方决定投降，这局是你的啦～🎉' : '已认输，下局再来一决高下！💪')
      : s.reason === 'timeout' ? `${turnName}超时，${winner}获胜。` : s.reason === 'five' ? '五子连线！要不要交换黑白再来一局？'
      : s.reason === 'disconnect_timeout' ? '断线等待超过 5 分钟。双方回来后，可以再来一局。' : '棋盘已满，双方都没有五子连线。';
  }
  el('gameStatus').textContent = s.reason === 'resign' && s.phase === 'finished' ? text : title;
  el('lobbyTitle').textContent = title;
  el('lobbyText').textContent = text;
  el('turnHint').textContent = s.phase === 'running' ? `第 ${s.moves.length + 1} 手 · ${s.turnSeat === s.blackSeat ? '黑棋' : '白棋'}行棋`
    : s.phase === 'waiting' ? '双方准备后，黑棋先行' : s.phase === 'finished' ? '结果由服务端确认' : text;
  button('ready').hidden = s.phase !== 'waiting';
  button('ready').textContent = own.ready ? '准备好啦！等对方' : '准备好啦！';
  el('readyNotice').hidden = s.phase !== 'waiting' || !s.players[2 - s.seat].ready;
  button('ready').disabled = busy || !connected || !own.synced || own.ready || !s.players[1].name || !!uncertain;
  button('rematch').hidden = s.phase !== 'finished';
  button('rematch').textContent = own.ready ? '已同意，等对方' : '再来一局 · 交换黑白';
  button('rematch').disabled = busy || !connected || !own.synced || own.ready || !!uncertain;
  const rematchInvite = s.phase === 'finished' && s.players[2 - s.seat].ready && !own.ready;
  el('rematchPanel').hidden = !rematchInvite;
  button('acceptRematch').disabled = button('rematch').disabled;
  const nextResultKey = s.phase === 'finished' && s.winner ? `${s.gameId}:${s.reason}:${s.winner}` : '';
  if (nextResultKey !== resultKey) {
    resultKey = nextResultKey;
    el('resultAvatar').innerHTML = s.winner ? avatar(s.players[s.winner - 1].animal) : '';
    el('resultTitle').textContent = `${winner}赢啦！！`;
    el('resultReason').textContent = s.reason === 'resign' ? `${s.players[2 - s.winner!].name}已认输✋️😭✋️` : s.reason === 'timeout' ? `${turnName}行棋超时` : '五子连线，这一局好精彩哇！';
  }
  el('resultPanel').hidden = replayStep !== null || !resultKey || dismissedResult === resultKey;
  if (s.application) el('applicantName').textContent = `${s.application.name}想加入你的房间👀请确认是对方本人哦！`;
  for (const id of ['approve', 'reject', 'leave']) button(id).disabled = busy || !connected || !!uncertain;
  button('confirm').disabled = !selection || !canMove();
  button('cancel').disabled = !selection || busy;
  button('resign').disabled = !canResign();
  button('confirmResign').disabled = !canResign() || resignGame !== s.gameId;
  const resignDialog = el('resignDialog') as HTMLDialogElement;
  if (resignDialog.open && (resignGame !== s.gameId || !['running', 'paused'].includes(s.phase))) resignDialog.close();
  if (!['running', 'paused'].includes(s.phase)) (el('undoDialog') as HTMLDialogElement).close();
  button('undo').disabled = busy || !connected || !!uncertain || s.phase !== 'running' || own.undoLeft === 0
    || !s.players.every(p => p.online && p.synced) || !s.moves.some(m => m.seat === s.seat);
  const request = s.undoRequest;
  el('undoPanel').hidden = !request;
  if (request) {
    const requester = s.players[request.seat - 1].name;
    el('undoImpact').textContent = `同意后撤销最近 ${request.removeCount} 颗棋子，重新轮到${requester}，恢复 ${Math.ceil(request.restoreMs / 1000)} 秒。`;
    button('acceptUndo').hidden = request.seat === s.seat;
    button('denyUndo').hidden = request.seat === s.seat;
    button('cancelUndo').hidden = request.seat !== s.seat;
    for (const id of ['acceptUndo', 'denyUndo', 'cancelUndo']) button(id).disabled = busy || !connected || !!uncertain;
  }
  for (const node of el('reactions').querySelectorAll<HTMLButtonElement>('button')) {
    node.disabled = busy || !connected || !!uncertain || s.phase === 'closed' || !s.players.every(p => p.online && p.synced);
  }
  el('selectionHint').textContent = selection ? `已选 ${String.fromCharCode(65 + selection.x)}${selection.y + 1}，确认后才落子` : '点选交叉点，再确认落子';
  renderReplay(); renderBoard(); renderClock();
}

function apply(reply: Reply) {
  const wasConnected = connected;
  if (reply.pending) {
    if (reply.withdrawn) return;
    connected = true; superseded = false; pending = true; applicationId = reply.applicationId;
    snapshot = null; room = reply.room; render(); return;
  }
  if (snapshot && (reply.version < snapshot.version || reply.serverNow < snapshot.serverNow)) return;
  if (snapshot?.gameId !== reply.gameId || reply.phase !== 'finished') replayStep = null;
  connected = true; superseded = false;
  if (snapshot?.gameId !== reply.gameId || snapshot.moves.length !== reply.moves.length || reply.phase !== 'running') selection = null;
  if (snapshot?.gameId !== reply.gameId) bubbles.clear();
  for (const event of reply.emojis) {
    if (!seenReactions.has(event.id) && wasConnected && snapshot?.gameId === reply.gameId && reply.serverNow - event.at <= 10000) {
      bubbles.set(event.seat, { reaction: event.emoji, until: performance.now() + 1500 });
    }
    seenReactions.add(event.id);
  }
  if (seenReactions.size > 100) { seenReactions.clear(); reply.emojis.forEach(e => seenReactions.add(e.id)); }
  if (reply.undoDenied) {
    const key = `gomoku.denial.${reply.room}.${reply.gameId}`;
    if (sessionStorage.getItem(key) !== reply.undoDenied.id) {
      sessionStorage.setItem(key, reply.undoDenied.id);
      feedback('对方残忍拒绝了你的悔棋申请😭', true);
    }
  }
  audio.play(soundEvents.observe(reply, wasConnected && !document.hidden && performance.now() - lastReceiptAt < 15000));
  snapshot = reply; pending = false; room = reply.room;
  serverAtReceipt = reply.serverNow; lastReceiptAt = performance.now();
  if (reply.phase === 'closed') forgetRoom(reply.room);
  else { storedRoom = room; localStorage.setItem('gomoku.room', room); }
  history.replaceState(null, '', `#${room}`);
  render();
}

function command(action: Action, data: Record<string, unknown> = {}): Command {
  return { p_room: room, p_action: action, p_client: client, p_operation: null,
    p_version: snapshot?.version ?? null, p_game: snapshot?.gameId ?? null, p_data: data, p_protocol: 1 };
}

async function exchange(request: Command) {
  const active = epoch;
  const reply = await send(request);
  if (active !== epoch) return null;
  apply(reply);
  return reply;
}

async function synchronize() {
  for (let i = 0; i < 3 && snapshot && !snapshot.players[snapshot.seat - 1].synced && snapshot.phase !== 'closed'; i++) {
    await exchange(command('sync'));
  }
}

async function run(work: () => Promise<void>) {
  if (busy) return;
  lastActivityAt = performance.now();
  busy = true; render();
  try {
    if (idlePaused && room) { idlePaused = false; await refreshRoom(); }
    await work();
  }
  catch (error) { failure(error); }
  finally { busy = false; render(); }
}

function recoverUncertain() {
  const saved = sessionStorage.getItem(`gomoku.operation.${room}`);
  if (!saved) return;
  try {
    const value: unknown = JSON.parse(saved);
    if (value && typeof value === 'object' && 'p_room' in value && value.p_room === room && 'p_operation' in value && typeof value.p_operation === 'string') {
      uncertain = value as Command;
    }
  } catch { notice('上次操作记录无法读取，请核对棋盘后继续', true); }
}

async function mutate(action: Action, data: Record<string, unknown> = {}, retry = false, rebase = true,
  expected: Pick<Snapshot, 'version' | 'gameId'> | null = null) {
  if (!snapshot || (!retry && uncertain)) return;
  const request = retry && uncertain ? { ...uncertain, p_client: client } : { ...command(action, data), p_operation: createId(),
    ...(expected ? { p_version: expected.version, p_game: expected.gameId } : {}) };
  uncertain = request;
  sessionStorage.setItem(`gomoku.operation.${room}`, JSON.stringify(request));
  const reply = await exchange(request);
  if (!reply || reply.pending) return;
  uncertain = null; sessionStorage.removeItem(`gomoku.operation.${room}`);
  selection = null;
  const sameIntent = ((action === 'ready' || action === 'rematch') && reply.phase === (action === 'ready' ? 'waiting' : 'finished'))
    || ((action === 'undo_respond' || action === 'undo_cancel') && reply.phase === 'paused' && reply.undoRequest?.id === data.request);
  if (!reply.accepted && reply.rejection === 'state_conflict' && rebase && !retry && sameIntent && reply.gameId === request.p_game) {
    await synchronize(); await mutate(action, data, false, false); return;
  }
  const message = reply.reason === 'resign' && reply.phase === 'finished' ? (reply.winner === reply.seat
    ? '对方决定投降，这局是你的啦～🎉' : '已认输，下局再来一决高下！💪') : reply.accepted ? action === 'move' ? '落子已保存，等对方下一步。' : '已同步，棋盘与对方保持一致。' : errorMessage(reply.rejection || '');
  notice(message);
  if (!reply.accepted) feedback(message, true);
  await synchronize();
}

async function connect(action: 'create' | 'apply' | 'connect', target: string) {
  soundEvents.reset(); audio.stop();
  epoch++; room = target; snapshot = null; pending = false; applicationId = null;
  connected = false; selection = null; uncertain = null; replayStep = null;
  notice('正在连接你们的棋桌…');
  await login();
  const name = input('nickname').value.trim();
  const data = action === 'create' ? { name: name || (animal === 'dog' ? '狗狗' : '猫猫'), animal }
    : action === 'apply' ? { name: name || '朋友', autoName: !name } : {};
  await exchange(command(action, data)); await synchronize(); recoverUncertain();
  notice(pending ? '加入申请已送达！等房主确认ing...' : uncertain ? '已恢复棋盘，请重试上次操作以核对结果。' : '连接正常。');
  if (!pending && !uncertain) connectionStatus();
}

async function refreshRoom() {
  const active = epoch;
  try { await exchange(command('snapshot')); }
  catch (error) {
    if (active !== epoch) return;
    if (!(error instanceof RpcError) || error.code !== 'connect_required') throw error;
    await exchange(command('connect'));
  }
  if (active === epoch) await synchronize();
}

function connectionStatus() {
  if (connected) notice(snapshot?.phase === 'finished' && snapshot.reason === 'resign' ? (snapshot.winner === snapshot.seat
    ? '对方决定投降，这局是你的啦～🎉' : '已认输，下局再来一决高下！💪') : snapshot?.phase === 'closed' ? '房间已关闭。' : pending ? '加入申请已送达！等房主确认ing...' : '连接正常。');
}

async function poll() {
  if (!room || busy || polling || document.hidden || superseded || snapshot?.phase === 'closed') return;
  if (snapshot?.phase !== 'running' && snapshot?.phase !== 'paused' && performance.now() - lastActivityAt >= 120000) {
    if (!idlePaused) {
      idlePaused = true; connected = false; render();
      notice('暂歇自动同步，轻触页面或点击重新连接即可继续。');
    }
    return;
  }
  idlePaused = false;
  const active = epoch;
  polling = true;
  try {
    await refreshRoom();
    if (active !== epoch) return;
    connectionStatus();
  } catch (error) {
    if (active === epoch) failure(error);
  } finally { polling = false; render(); }
}

function select(point: Point) {
  if (!canMove() || snapshot?.moves.some(m => m.x === point.x && m.y === point.y)) return;
  selection = point; render();
}

const board = el('board');
for (let y = 0; y < 15; y++) {
  for (let x = 0; x < 15; x++) {
    const cell = document.createElement('button'); cell.type = 'button'; cell.setAttribute('role', 'gridcell');
    cell.dataset.x = String(x); cell.dataset.y = String(y); cell.tabIndex = x === 7 && y === 7 ? 0 : -1;
    let pointer: { x: number; y: number; moved: boolean } | null = null;
    cell.addEventListener('pointerdown', event => { pointer = { x: event.clientX, y: event.clientY, moved: false }; });
    cell.addEventListener('pointermove', event => {
      if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= 10) pointer.moved = true;
    });
    cell.addEventListener('pointercancel', () => { pointer = null; });
    cell.addEventListener('pointerup', event => {
      if (pointer && !pointer.moved && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 10) select({ x, y });
      pointer = null;
    });
    cell.addEventListener('click', event => { if (event.detail === 0) select({ x, y }); });
    cell.addEventListener('keydown', event => {
      const offset: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -15, ArrowDown: 15 };
      if (event.key in offset) {
        event.preventDefault();
        const next = Math.max(0, Math.min(224, y * 15 + x + offset[event.key]));
        cells.forEach(c => c.tabIndex = -1); cells[next].tabIndex = 0; cells[next].focus();
      } else if (event.key === 'Escape') { selection = null; render(); }
    });
    cells.push(cell); board.appendChild(cell);
  }
}
const svgLines = Array.from({ length: 15 }, (_, i) => `<path d="M.5 ${i + .5}H14.5M${i + .5} .5V14.5"/>`).join('');
el('boardLines').innerHTML = `<g stroke="#91794f" stroke-width=".025">${svgLines}</g>${[[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]].map(([x, y]) => `<circle cx="${x + .5}" cy="${y + .5}" r=".07" fill="#91794f"/>`).join('')}`;
el('dog').innerHTML = `${avatar('dog')}<span>狗狗</span>`;
el('cat').innerHTML = `${avatar('cat')}<span>猫猫</span>`;
el('introArt').innerHTML = avatar('cat') + avatar('dog');
for (const value of ['dog', 'cat'] as const) button(value).onclick = () => {
  if (invited && invitationInfo?.animal !== value) return;
  void audio.animal(value);
  animal = value; input('nickname').placeholder = value === 'dog' ? '狗狗' : '猫猫';
  button('dog').setAttribute('aria-pressed', String(value === 'dog')); button('cat').setAttribute('aria-pressed', String(value === 'cat'));
};
function setInvitationMode(active: boolean) {
  invited = active; invitationInfo = null;
  const entry = el('joinEntry');
  el('entryPanel').insertBefore(entry, active ? button('create') : button('create').nextSibling);
  el('entryTitle').textContent = active ? '对方在等你，一起入座' : '今天，你是谁？';
  render();
}
async function loadInvitation() {
  const target = input('roomInput').value.trim(), active = epoch;
  invitationInfo = null; render();
  await login();
  const info = await inspectInvitation({ ...command('preview'), p_room: target });
  if (!invited || epoch !== active || target !== input('roomInput').value.trim()) return;
  invitationInfo = info; animal = info.animal;
  input('nickname').placeholder = animal === 'cat' ? '猫猫' : '狗狗';
  button('dog').setAttribute('aria-pressed', String(animal === 'dog'));
  button('cat').setAttribute('aria-pressed', String(animal === 'cat')); render();
}
input('roomInput').addEventListener('input', () => { if (invited) { invitationInfo = null; render(); } });
input('roomInput').addEventListener('change', () => { if (invited && roomPattern.test(input('roomInput').value.trim())) void run(loadInvitation); });
button('retryInvitation').onclick = () => { void run(loadInvitation); };
button('create').onclick = () => {
  if (invited) { epoch++; setInvitationMode(false); history.replaceState(null, '', location.pathname); return; }
  void run(() => connect('create', createId()));
};
el('joinForm').onsubmit = event => {
  event.preventDefault(); const target = input('roomInput').value.trim();
  if (!roomPattern.test(target)) { notice('请输入 10 位房间码，或打开对方的邀请链接', true); return; }
  if (invited && !invitationInfo) { feedback('请先等房间角色确认完成，再加入。', true); return; }
  void run(() => connect('apply', target));
};
button('resume').onclick = () => { void run(() => connect('connect', storedRoom)); };
button('reconnect').onclick = () => { void run(async () => {
  if (pending) { await login(); await refreshRoom(); }
  else await connect('connect', room);
}); };
button('retry').onclick = () => { void run(async () => { if (!connected) { await login(); await exchange(command('connect')); await synchronize(); } await mutate('move', {}, true); }); };
button('ready').onclick = () => { void run(() => mutate('ready')); };
button('rematch').onclick = () => { void run(() => mutate('rematch')); };
button('acceptRematch').onclick = () => { void run(() => mutate('rematch')); };
button('dismissResult').onclick = () => { dismissedResult = resultKey; el('resultPanel').hidden = true; };
button('reviewGame').onclick = () => {
  if (snapshot?.phase !== 'finished') return;
  replayStep = snapshot.moves.length; showReplayNumbers = true; selection = null; render();
  input('replayProgress').focus();
};
button('exitReplay').onclick = () => { replayStep = null; render(); button('reviewGame').focus(); };
button('replayStart').onclick = () => seekReplay(0);
button('replayPrevious').onclick = () => seekReplay((replayStep ?? 0) - 1);
button('replayNext').onclick = () => seekReplay((replayStep ?? 0) + 1);
button('replayEnd').onclick = () => seekReplay(snapshot?.moves.length ?? 0);
input('replayProgress').oninput = () => seekReplay(input('replayProgress').valueAsNumber);
button('toggleReplayNumbers').onclick = () => {
  if (snapshot?.phase !== 'finished' || replayStep === null) return;
  showReplayNumbers = !showReplayNumbers; renderReplay(); renderBoard();
};
button('dismissFeedback').onclick = () => { el('feedback').hidden = true; };
button('approve').onclick = () => { void run(() => mutate('approve', { application: snapshot?.application?.id })); };
button('reject').onclick = () => { void run(() => mutate('reject', { application: snapshot?.application?.id })); };
button('confirm').onclick = () => { if (selection && canMove()) { const point = selection; void run(() => mutate('move', { x: point.x, y: point.y })); } };
button('cancel').onclick = () => { selection = null; render(); };
const resignDialog = el('resignDialog') as HTMLDialogElement;
button('resign').onclick = () => {
  if (!canResign()) return;
  resignGame = snapshot!.gameId;
  button('confirmResign').disabled = false;
  resignDialog.showModal();
};
button('dismissResign').onclick = () => resignDialog.close();
button('confirmResign').onclick = () => {
  if (!canResign() || snapshot?.gameId !== resignGame) return;
  const expected = { version: snapshot.version, gameId: resignGame };
  resignDialog.close();
  void run(() => mutate('resign', {}, false, false, expected));
};
const undoDialog = el('undoDialog') as HTMLDialogElement;
button('undo').onclick = () => { void run(async () => {
  await exchange(command('snapshot')); await synchronize();
  if (!snapshot || snapshot.phase !== 'running') return;
  if (snapshot.undoBlocked) { feedback('你本轮申请过但是失败了，下次再试试吧~', true); return; }
  const index = snapshot.moves.findLastIndex(m => m.seat === snapshot!.seat);
  if (index < 0) return;
  const move = snapshot.moves[index]; undoTarget = move.id ?? `legacy-${index}`;
  undoProposal = { version: snapshot.version, gameId: snapshot.gameId };
  const seconds = Math.ceil(Math.min(60000, Math.max(15000, move.remainingMs ?? 60000)) / 1000);
  el('undoPreview').textContent = `对方同意后，撤销最近 ${snapshot.moves.length - index} 颗棋子，由你重新落子，恢复 ${seconds} 秒。本局悔棋剩余${snapshot.players[snapshot.seat - 1].undoLeft}次。`;
  undoDialog.showModal();
}); };
button('dismissUndo').onclick = () => undoDialog.close();
button('requestUndo').onclick = () => { undoDialog.close(); void run(() => mutate('undo_request', { target: undoTarget }, false, true, undoProposal)); };
button('acceptUndo').onclick = () => { void run(() => mutate('undo_respond', { request: snapshot?.undoRequest?.id, accept: true })); };
button('denyUndo').onclick = () => { void run(() => mutate('undo_respond', { request: snapshot?.undoRequest?.id, accept: false })); };
button('cancelUndo').onclick = () => { void run(() => mutate('undo_cancel', { request: snapshot?.undoRequest?.id })); };
const reactionNames: Record<Reaction, string> = { plead: '拜托', cat: '猫猫', dog: '狗狗', heart: '爱心', laugh: '大笑', cry: '哭哭', angry: '生气', celebrate: '庆祝' };
for (const [id, emoji] of Object.entries(reactions)) {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = emoji;
  node.setAttribute('aria-label', `发送${reactionNames[id as Reaction]}表情`); node.dataset.emoji = id;
  node.onclick = () => { void run(() => mutate('emoji', { emoji: id })); }; el('reactions').appendChild(node);
}
button('cancelApplication').onclick = () => { void run(async () => {
  try {
    await exchange(command('withdraw', { application: applicationId })); home(); notice('已撤回加入申请。');
  } catch (error) {
    if (!(error instanceof RpcError) || error.code !== 'application_changed') throw error;
    await refreshRoom(); notice('房主已确认加入，房间已恢复。');
  }
}); };
button('homeReturn').onclick = () => { home(); notice('房间已关闭，可以重新创建或加入。'); };
const copyTimers = new Map<string, number>();
async function copy(id: string, value: string, label: string, success: string) {
  const target = button(id), active = epoch;
  window.clearTimeout(copyTimers.get(id));
  target.disabled = true;
  target.textContent = label;
  target.classList.remove('copied');
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(value);
    if (active !== epoch) return;
    el('copyFallback').hidden = true;
    target.textContent = success; target.classList.add('copied');
    el('copyStatus').textContent = success;
  } catch {
    if (active !== epoch) return;
    const box = el('copyFallback') as HTMLTextAreaElement;
    box.hidden = false; box.value = value; box.setAttribute('aria-label', `${label}失败，请手动复制`);
    box.focus(); box.select();
    el('copyStatus').textContent = '复制失败，请长按或选中下方内容手动复制。';
    feedback('复制失败，请手动复制下方内容。', true);
  } finally {
    target.disabled = false;
    copyTimers.set(id, window.setTimeout(() => { target.textContent = label; target.classList.remove('copied'); }, 5000));
  }
}
button('invite').onclick = () => { void copy('invite', `${location.origin}${location.pathname}#${snapshot?.code || room}`, '复制邀请链接', '复制成功！发送给对方让TA加入吧~'); };
button('copyCode').onclick = () => { if (snapshot) void copy('copyCode', snapshot.code, '复制房间码', '房间码复制成功！'); };
const leaveDialog = el('leaveDialog') as HTMLDialogElement;
button('leave').onclick = () => leaveDialog.showModal();
button('stay').onclick = () => leaveDialog.close();
button('confirmLeave').onclick = () => {
  leaveDialog.close();
  void run(async () => {
    await mutate('leave');
    if (snapshot?.phase === 'closed') notice('房间已关闭。');
  });
};
window.addEventListener('offline', () => { audio.stop(); connected = false; selection = null; notice('网络已断开，恢复后会自动同步', true); render(); });
window.addEventListener('online', () => { void poll(); });
window.addEventListener('pagehide', () => { audio.stop(); connected = false; });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { audio.stop(); connected = false; selection = null; render(); }
  else { lastActivityAt = performance.now(); void poll(); }
});
window.addEventListener('pageshow', () => { if (room && !document.hidden) void poll(); });
for (const event of ['pointerdown', 'keydown'] as const) document.addEventListener(event, () => { lastActivityAt = performance.now(); }, { passive: true });
window.setInterval(() => { void poll(); }, 5000);
window.setInterval(renderClock, 250);
if (roomPattern.test(invitation)) {
  input('roomInput').value = invitation;
  if (invitation === storedRoom) void run(() => connect('connect', invitation));
  else { setInvitationMode(true); void run(loadInvitation); }
}
render();
