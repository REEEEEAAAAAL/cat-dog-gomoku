import './style.css';
import { avatar } from './avatars';
import { login, send } from './api';
import { clockText, createId } from './rules';
import type { Point } from './rules';
import { errorMessage } from './protocol';
import type { Action, Command, Reply, Snapshot } from './protocol';

const el = (id: string) => document.getElementById(id)!;
const button = (id: string) => el(id) as HTMLButtonElement;
const input = (id: string) => el(id) as HTMLInputElement;
const client = createId();
const roomPattern = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{10})$/i;
const storedRoom = localStorage.getItem('gomoku.room') || '';
const invitation = location.hash.slice(1);
let animal: 'dog' | 'cat' = 'dog';
let room = '';
let snapshot: Snapshot | null = null;
let pending = false;
let pendingName = '';
let pendingAutoName = true;
let busy = false;
let connected = false;
let superseded = false;
let selection: Point | null = null;
let lastReceiptAt = 0;
let serverAtReceipt = 0;
let epoch = 0;
let uncertain: Command | null = null;
let lastStatus = '';
const cells: HTMLButtonElement[] = [];

function notice(message: string, error = false) {
  if (lastStatus !== message) { el('notice').textContent = message; lastStatus = message; }
  el('connectionDot').className = `connection-dot ${error ? 'error' : connected ? 'online' : ''}`;
}

function canMove() {
  return !!snapshot && snapshot.phase === 'running' && snapshot.turnSeat === snapshot.seat
    && snapshot.players.every(p => p.online && p.synced) && connected && !busy && !uncertain
    && !document.hidden && performance.now() - lastReceiptAt < 15000;
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
  if (performance.now() - lastReceiptAt >= 15000 && connected) {
    connected = false; selection = null; render(); notice('正在重新同步，暂时不能落子', true);
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
    node.querySelector('.player-name')!.textContent = p.name ? `${p.name}${seat === s.seat ? '（你）' : '（对方）'}` : '等待对方入座';
    node.querySelector('.player-detail span')!.textContent = `${s.blackSeat === seat ? '黑棋' : '白棋'} · ${!p.name ? '未加入' : !p.online ? '离线' : !p.synced ? '同步中' : p.ready ? '已准备' : '在线'}`;
    container.appendChild(node);
  }
}

function renderBoard() {
  const s = snapshot;
  const map = new Map(s?.moves.map((m, i) => [`${m.x},${m.y}`, { ...m, last: i === s.moves.length - 1 }]));
  for (let i = 0; i < cells.length; i++) {
    const x = i % 15, y = Math.floor(i / 15), cell = cells[i];
    const move = map.get(`${x},${y}`);
    const preview = !move && selection?.x === x && selection.y === y;
    const color = move?.color ?? (s?.seat === s?.blackSeat ? 1 : 2);
    cell.innerHTML = move || preview ? `<span class="stone ${color === 2 ? 'white' : ''} ${move?.last ? 'last' : ''} ${preview ? 'preview' : ''}"></span>` : '';
    cell.setAttribute('aria-label', `${String.fromCharCode(65 + x)}${y + 1}${move ? color === 1 ? ' 黑棋' : ' 白棋' : ' 空位'}${preview ? ' 已选' : ''}`);
    cell.setAttribute('aria-disabled', String(!!move || !canMove()));
  }
  const line = s?.winLine;
  if (line?.length) {
    const sorted = [...line].sort((a, b) => a.x - b.x || a.y - b.y);
    const first = sorted[0], last = sorted[sorted.length - 1];
    el('winOverlay').innerHTML = `<line x1="${first.x + .5}" y1="${first.y + .5}" x2="${last.x + .5}" y2="${last.y + .5}" stroke="#b46f40" stroke-width=".12" stroke-linecap="round"/>`;
  } else el('winOverlay').replaceChildren();
}

function render() {
  el('home').hidden = !(!room);
  el('room').hidden = !room;
  const s = snapshot;
  document.querySelector<HTMLElement>('.play-area')!.hidden = pending || !s;
  el('pendingPanel').hidden = !pending;
  el('lobbyPanel').hidden = !s;
  el('invitePanel').hidden = !s || s.phase === 'closed';
  el('applicationPanel').hidden = !s?.application;
  button('reconnect').hidden = !room || busy || (connected && !superseded);
  button('retry').hidden = !uncertain || busy;
  button('create').disabled = busy;
  button('join').disabled = busy;
  button('resume').hidden = !roomPattern.test(storedRoom);
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
    title = `${turnName}的回合`; text = s.turnSeat === s.seat ? '轮到你了，选一个空交叉点' : '等对方想一想，下一步就到你';
  } else if (s.phase === 'paused') {
    title = '等你们重新连上'; text = '棋盘已保存。双方恢复连接并同步后，继续剩余时间。';
  } else if (s.phase === 'waiting') {
    title = s.players[1].name ? '都准备好，就开局' : '等另一个人来'; text = '分享邀请链接，房主确认加入后，双方点击准备。';
  } else if (s.phase === 'closed') {
    title = '房间已关闭'; text = '本房间不能继续，可以返回首页再建一间。';
  } else {
    title = s.reason === 'draw' ? '这一局，平分秋色' : s.reason === 'disconnect_timeout' ? '本局已中止，不计输赢' : `${winner}获胜`;
    text = s.reason === 'timeout' ? `${turnName}超时，${winner}获胜。` : s.reason === 'five' ? '五子连线！要不要交换黑白再来一局？'
      : s.reason === 'disconnect_timeout' ? '断线等待超过 5 分钟。双方回来后，可以再来一局。' : '棋盘已满，双方都没有五子连线。';
  }
  el('gameStatus').textContent = title;
  el('lobbyTitle').textContent = title;
  el('lobbyText').textContent = text;
  el('turnHint').textContent = s.phase === 'running' ? `第 ${s.moves.length + 1} 手 · ${s.turnSeat === s.blackSeat ? '黑棋' : '白棋'}行棋`
    : s.phase === 'waiting' ? '双方准备后，黑棋先行' : s.phase === 'finished' ? '结果由服务端确认' : text;
  button('ready').hidden = s.phase !== 'waiting';
  button('ready').textContent = own.ready ? '已准备，等对方' : '准备好了';
  button('ready').disabled = busy || !connected || !own.synced || own.ready || !s.players[1].name || !!uncertain;
  button('rematch').hidden = s.phase !== 'finished';
  button('rematch').textContent = own.ready ? '已同意，等对方' : '再来一局 · 交换黑白';
  button('rematch').disabled = busy || !connected || !own.synced || own.ready || !!uncertain;
  if (s.application) el('applicantName').textContent = `${s.application.name} 想加入你的房间。请确认是对方本人。`;
  for (const id of ['approve', 'reject', 'leave']) button(id).disabled = busy || !connected || !!uncertain;
  button('confirm').disabled = !selection || !canMove();
  button('cancel').disabled = !selection || busy;
  el('selectionHint').textContent = selection ? `已选 ${String.fromCharCode(65 + selection.x)}${selection.y + 1}，确认后才落子` : '手机点选交叉点，再确认落子';
  renderBoard(); renderClock();
}

function apply(reply: Reply) {
  connected = true; superseded = false;
  if (reply.pending) { pending = true; snapshot = null; room = reply.room; render(); return; }
  if (snapshot && (reply.version < snapshot.version || reply.serverNow < snapshot.serverNow)) return;
  if (snapshot?.gameId !== reply.gameId || snapshot.moves.length !== reply.moves.length || reply.phase !== 'running') selection = null;
  snapshot = reply; pending = false; room = reply.room;
  serverAtReceipt = reply.serverNow; lastReceiptAt = performance.now();
  localStorage.setItem('gomoku.room', room);
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
  busy = true; render();
  try { await work(); }
  catch (error) {
    connected = false; selection = null;
    const message = error instanceof Error ? error.message : '连接失败，稍后会自动重试';
    superseded = message === errorMessage('superseded');
    notice(uncertain ? `${message}。上次操作结果未知，请重试核对，避免重复落子。` : message, true);
  } finally { busy = false; render(); }
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

async function mutate(action: Action, data: Record<string, unknown> = {}, retry = false, rebase = true) {
  if (!snapshot || (!retry && uncertain)) return;
  const request = retry && uncertain ? { ...uncertain, p_client: client } : { ...command(action, data), p_operation: createId() };
  uncertain = request;
  sessionStorage.setItem(`gomoku.operation.${room}`, JSON.stringify(request));
  const reply = await exchange(request);
  if (!reply || reply.pending) return;
  uncertain = null; sessionStorage.removeItem(`gomoku.operation.${room}`);
  selection = null;
  if (!reply.accepted && reply.rejection === 'state_conflict' && rebase && !retry
    && (action === 'ready' || action === 'rematch') && reply.gameId === request.p_game
    && reply.phase === (action === 'ready' ? 'waiting' : 'finished')) {
    await synchronize(); await mutate(action, data, false, false); return;
  }
  notice(reply.accepted ? action === 'move' ? '落子已保存，等对方下一步。' : '已同步，棋盘与对方保持一致。' : errorMessage(reply.rejection || ''));
  await synchronize();
}

async function connect(action: 'create' | 'apply' | 'connect', target: string) {
  epoch++; room = target; snapshot = null; pending = false; connected = false; selection = null; uncertain = null;
  notice('正在连接你们的棋桌…');
  await login();
  const name = input('nickname').value.trim();
  pendingName = name || '朋友'; pendingAutoName = !name;
  const data = action === 'create' ? { name: name || (animal === 'dog' ? '狗狗' : '猫猫'), animal }
    : action === 'apply' ? { name: pendingName, autoName: pendingAutoName } : {};
  await exchange(command(action, data)); await synchronize(); recoverUncertain();
  notice(pending ? '申请已送达，等房主确认。' : uncertain ? '已恢复棋盘，请重试上次操作以核对结果。' : '连接正常。');
}

async function poll() {
  if (!room || busy || document.hidden || superseded) return;
  await run(async () => {
    await exchange(command(pending ? 'apply' : 'snapshot', pending ? { name: pendingName, autoName: pendingAutoName } : {}));
    await synchronize();
    if (connected) notice(pending ? '申请已送达，等房主确认。' : '连接正常。');
  });
}

function select(point: Point, direct = false) {
  if (!canMove() || snapshot?.moves.some(m => m.x === point.x && m.y === point.y)) return;
  selection = point; render();
  if (direct) void run(() => mutate('move', { x: point.x, y: point.y }));
}

const board = el('board');
for (let y = 0; y < 15; y++) {
  for (let x = 0; x < 15; x++) {
    const cell = document.createElement('button'); cell.type = 'button'; cell.setAttribute('role', 'gridcell');
    cell.dataset.x = String(x); cell.dataset.y = String(y); cell.tabIndex = x === 7 && y === 7 ? 0 : -1;
    let pointer: { x: number; y: number } | null = null;
    cell.addEventListener('pointerdown', event => { pointer = { x: event.clientX, y: event.clientY }; });
    cell.addEventListener('pointercancel', () => { pointer = null; });
    cell.addEventListener('pointerup', event => {
      if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 10) select({ x, y }, event.pointerType === 'mouse');
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
el('introArt').innerHTML = avatar('dog') + avatar('cat');
for (const value of ['dog', 'cat'] as const) button(value).onclick = () => {
  animal = value; input('nickname').placeholder = value === 'dog' ? '狗狗' : '猫猫';
  button('dog').setAttribute('aria-pressed', String(value === 'dog')); button('cat').setAttribute('aria-pressed', String(value === 'cat'));
};
button('create').onclick = () => { void run(() => connect('create', createId())); };
el('joinForm').onsubmit = event => {
  event.preventDefault(); const target = input('roomInput').value.trim();
  if (!roomPattern.test(target)) { notice('请输入 10 位房间码，或打开对方的邀请链接', true); return; }
  void run(() => connect('apply', target));
};
button('resume').onclick = () => { void run(() => connect('connect', storedRoom)); };
button('reconnect').onclick = () => { void run(() => connect(pending ? 'apply' : 'connect', room)); };
button('retry').onclick = () => { void run(async () => { if (!connected) { await login(); await exchange(command('connect')); await synchronize(); } await mutate('move', {}, true); }); };
button('ready').onclick = () => { void run(() => mutate('ready')); };
button('rematch').onclick = () => { void run(() => mutate('rematch')); };
button('approve').onclick = () => { void run(() => mutate('approve', { application: snapshot?.application?.id })); };
button('reject').onclick = () => { void run(() => mutate('reject', { application: snapshot?.application?.id })); };
button('confirm').onclick = () => { if (selection && canMove()) { const point = selection; void run(() => mutate('move', { x: point.x, y: point.y })); } };
button('cancel').onclick = () => { selection = null; render(); };
button('cancelApplication').onclick = () => { epoch++; room = ''; pending = false; snapshot = null; connected = false; history.replaceState(null, '', location.pathname); render(); };
button('invite').onclick = () => {
  const link = `${location.origin}${location.pathname}#${room}`;
  void navigator.clipboard?.writeText(link).then(() => notice('邀请链接已复制，发给对方就好。')).catch(() => {
    const box = el('copyFallback') as HTMLTextAreaElement; box.hidden = false; box.value = link; box.focus(); box.select(); notice('请长按链接手动复制');
  });
  if (!navigator.clipboard) { const box = el('copyFallback') as HTMLTextAreaElement; box.hidden = false; box.value = link; box.focus(); box.select(); notice('请长按链接手动复制'); }
};
const leaveDialog = el('leaveDialog') as HTMLDialogElement;
button('leave').onclick = () => leaveDialog.showModal();
button('stay').onclick = () => leaveDialog.close();
button('confirmLeave').onclick = () => {
  leaveDialog.close();
  void run(async () => {
    await mutate('leave');
    if (snapshot?.phase === 'closed') { localStorage.removeItem('gomoku.room'); notice('房间已关闭，点击左上角返回首页。'); }
  });
};
window.addEventListener('offline', () => { connected = false; selection = null; notice('网络已断开，恢复后会自动同步', true); render(); });
window.addEventListener('online', () => { void poll(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { connected = false; selection = null; render(); }
  else void poll();
});
window.addEventListener('pageshow', () => { if (room && !document.hidden) void poll(); });
window.setInterval(() => { void poll(); }, 5000);
window.setInterval(renderClock, 250);
if (roomPattern.test(invitation)) {
  input('roomInput').value = invitation;
  el('entryTitle').textContent = '对方在等你，一起入座';
  input('nickname').placeholder = '留空使用狗狗或猫猫';
  if (invitation === storedRoom) void run(() => connect('connect', invitation));
}
render();
