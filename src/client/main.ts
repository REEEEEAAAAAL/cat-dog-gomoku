import { HEARTBEAT_MS, HEALTH_MS, type Seat, type Session } from '../shared/session';
import './style.css';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
}
const button = (id: string) => el<HTMLButtonElement>(id);
let room = location.hash.slice(1) || sessionStorage.getItem('diagRoom') || '';
if (!/^[a-f0-9-]{36}$/.test(room)) room = '';
history.replaceState(null, '', location.pathname);
let ws: WebSocket | null = null;
let state: Session | null = null;
let seat: Seat | undefined;
let manual = false;
let attempt = 0;
let connectionGeneration = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let lastServer = 0;
let lastPing = 0;
let snapshotAt = 0;
let snapshotServer = 0;
let sampling = false;
let nextSample: ReturnType<typeof setTimeout> | undefined;
let stats = freshStats();
const pending = new Map<string, { sent: number; command: { type: 'pulse' | 'start'; id: string; version: number }; acked: boolean; resend: boolean }>();
const ackTimes: number[] = [];
const deliveryTimes: number[] = [];
const bootIds = new Set<string>();
function freshStats() {
  return { startedAt: new Date().toISOString(), attempts: 0, connected: 0, reconnects: 0, sent: 0,
    received: 0, rejected: 0, uncertain: 0, alarms: 0, maxAlarmDelayMs: 0, disconnects: 0, pong: 0, syncs: 0 };
}
function event(text: string): void {
  const li = document.createElement('li'); li.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  el('events').insertBefore(li, el('events').firstChild); while (el('events').children.length > 30) el('events').lastChild?.remove();
}
function status(text: string): void { el('connection').textContent = text; }
function notice(text: string): void { el('notice').textContent = text; }
function send(command: object): void { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(command)); }
function percentile(values: number[]): number | null {
  return values.length ? Math.round([...values].sort((a,b) => a-b)[Math.ceil(values.length * .95) - 1]) : null;
}
function metric(values: number[]): string { return `${percentile(values) ?? '—'} ms / ${values.length}`; }
function stopSampling(text: string): void {
  sampling = false; clearTimeout(nextSample); el('sampleStatus').textContent = text;
}
function render(): void {
  const ready = ws?.readyState === WebSocket.OPEN && !!state?.peers.every(p => p.online && p.synced);
  button('pulse').disabled = !ready || sampling;
  button('sample').disabled = !ready || sampling;
  button('longSample').disabled = !ready || sampling;
  button('start').disabled = !ready || state?.phase === 'running' || state?.phase === 'paused' || state?.phase === 'expired';
  button('invite').disabled = !room;
  button('disconnect').disabled = !ws || ws.readyState !== WebSocket.OPEN;
  el('seat').textContent = seat === undefined ? '待分配' : `设备 ${seat + 1}`;
  el('count').textContent = String(state?.count ?? 0);
  el('peers').textContent = state ? state.peers.map((p,i) => `${i+1}：${p.synced ? '已同步' : p.online ? '同步中' : '离线'}`).join(' / ') : '等待连接';
  el('ack').textContent = metric(ackTimes); el('delivery').textContent = metric(deliveryTimes);
  el('reconnects').textContent = String(stats.reconnects);
}
async function connect(): Promise<void> {
  if (!room || manual) return;
  const generation = ++connectionGeneration;
  clearTimeout(retryTimer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  for (const p of pending.values()) if (!p.acked) p.resend = true;
  stats.attempts++; status('正在连接…'); sessionStorage.setItem('diagRoom', room);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 10_000);
  try {
    const res = await fetch(`/api/s/${room}/join`, { method: 'POST', signal: abort.signal });
    if (generation !== connectionGeneration) return;
    if (!res.ok) {
      if (res.status === 409 || res.status === 410) { manual = true; status(res.status === 409 ? '测试已满，请新建测试并重新邀请' : '测试已过期，请新建测试'); return; }
      throw new Error('连接入口失败');
    }
    const joined = await res.json() as { seat: Seat }; seat = joined.seat;
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/s/${room}/ws`);
    ws = socket;
    const openTimeout = setTimeout(() => { if (socket.readyState !== WebSocket.OPEN) socket.close(); }, 10_000);
    socket.onopen = () => {
      clearTimeout(openTimeout); stats.connected++; if (stats.connected > 1) stats.reconnects++;
      attempt = 0; lastServer = performance.now(); status('已连接，等待双方同步'); event('连接成功');
      lastPing = performance.now(); socket.send('ping'); render();
    };
    socket.onmessage = e => {
      lastServer = performance.now();
      if (e.data === 'pong') { stats.pong++; el('rtt').textContent = `${Math.round(performance.now() - lastPing)} ms`; return; }
      let m: { type: string; state?: Session; serverNow?: number; nonce?: string; bootId?: string; ack?: string; from?: Seat; delivered?: string;
        error?: string; rejected?: string; action?: string; alarm?: { delayMs: number | null; retry: number } };
      try { m = JSON.parse(String(e.data)) as typeof m; } catch { return; }
      if (m.type === 'error') { event(`请求未接受：${m.error}`); return; }
      if (m.state && m.serverNow) { state = m.state; snapshotAt = performance.now(); snapshotServer = m.serverNow; }
      if (m.bootId) bootIds.add(m.bootId);
      if (m.nonce) { send({ type: 'sync', nonce: m.nonce }); stats.syncs++; }
      if (m.state?.peers[seat ?? 0].synced) {
        status('已连接并同步');
        if (m.state.peers.every(p => p.synced)) for (const p of pending.values()) if (p.resend && !p.acked) {
          p.resend = false; send(p.command);
        }
      }
      if (m.ack) {
        const p = pending.get(m.ack);
        if (p && !p.acked) {
          if (p.command.type === 'pulse') { ackTimes.push(performance.now() - p.sent); stats.sent++; }
          p.acked = true; event(`操作已保存，计数 ${state?.count}`);
        }
        if (m.from !== undefined && m.from !== seat && m.action === 'pulse') { stats.received++; send({ type: 'received', id: m.ack }); event(`收到对方信号，计数 ${state?.count}`); }
        if (sampling && p?.command.type === 'pulse') queueSample();
      }
      if (m.delivered) { const p = pending.get(m.delivered); if (p) { deliveryTimes.push(performance.now() - p.sent); pending.delete(m.delivered); } }
      if (m.error) { stats.rejected++; if (m.rejected) pending.delete(m.rejected); stopSampling(`已停止：${m.error}，请只让一台设备自动发送后重试。`); event(`请求未接受：${m.error}`); }
      if (m.alarm) {
        stats.alarms++; stats.maxAlarmDelayMs = Math.max(stats.maxAlarmDelayMs, m.alarm.delayMs ?? 0);
        el('alarm').textContent = `已收到 ${stats.alarms} 次 Alarm 检查；本轮最大可测延迟 ${stats.maxAlarmDelayMs} ms；重试 ${m.alarm.retry}`;
      }
      render();
    };
    socket.onclose = e => {
      clearTimeout(openTimeout); if (socket !== ws) return;
      ws = null; stats.disconnects++; stopSampling('连接中断，自动发送已停止。'); render();
      if (e.code === 4002) { manual = true; status('此设备已由另一个页面接管，请关闭旧页面'); return; }
      if (e.code === 4001) { manual = true; status('测试已过期，请新建测试'); return; }
      status(manual ? '已模拟断开，点击重新连接恢复' : '连接中断，正在重连…'); event('连接断开');
      if (!manual) scheduleReconnect();
    };
    socket.onerror = () => status('连接未成功，正在检查网络…');
  } catch { if (generation === connectionGeneration) { status('暂时无法连接，自动重试中…'); event('连接尝试失败'); scheduleReconnect(); } }
  finally { clearTimeout(timeout); }
}
function scheduleReconnect(): void {
  if (manual) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { void connect(); }, Math.min(10_000, 500 * 2 ** Math.min(attempt++, 5)) * (.8 + Math.random() * .2));
}
function command(type: 'pulse' | 'start'): void {
  if (!state || ws?.readyState !== WebSocket.OPEN) return;
  const id = crypto.randomUUID(); const c = { type, id, version: state.version };
  pending.set(id, { sent: performance.now(), command: c, acked: false, resend: false });
  if (pending.size > 200) pending.delete(pending.keys().next().value ?? '');
  send(c);
}
let sampleCount = 0;
let sampleTarget = 100;
function queueSample(): void {
  if (!sampling) return;
  clearTimeout(nextSample);
  if (++sampleCount >= sampleTarget) { stopSampling(`${sampleTarget} 次发送已确认，请等对端确认样本收齐后复制报告。`); return; }
  el('sampleStatus').textContent = `本批 ${sampleCount} / ${sampleTarget} 次确认`;
  nextSample = setTimeout(() => { command('pulse'); }, 3_000);
}
async function copy(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); notice('已复制。'); }
  catch { const box = el<HTMLTextAreaElement>('copybox'); box.hidden = false; box.value = text; box.focus(); box.select(); notice('自动复制不可用，请长按或手动复制上方文本。'); }
}
button('create').onclick = () => {
  manual = true; connectionGeneration++; clearTimeout(retryTimer); ws?.close();
  room = crypto.randomUUID(); state = null; seat = undefined; pending.clear(); manual = false; void connect(); render();
};
button('invite').onclick = () => { void copy(`${location.origin}/#${room}`); };
button('retry').onclick = () => { manual = false; void connect(); };
button('disconnect').onclick = () => { manual = true; connectionGeneration++; clearTimeout(retryTimer); ws?.close(1000, 'diagnostic_disconnect'); };
button('pulse').onclick = () => command('pulse');
button('start').onclick = () => command('start');
button('sample').onclick = () => { sampling = true; sampleCount = 0; sampleTarget = 100; command('pulse'); render(); };
button('longSample').onclick = () => { sampling = true; sampleCount = 0; sampleTarget = 600; command('pulse'); render(); };
button('resetStats').onclick = () => {
  stats = freshStats(); ackTimes.length = 0; deliveryTimes.length = 0; bootIds.clear(); pending.clear();
  stopSampling('已开始新一轮统计；刷新会重新统计连接尝试。'); render(); notice('本轮统计已清空，持久化计数保持不变。');
};
button('report').onclick = () => {
  const report = {
    app: 'Cat & Dog Gomoku stage 0 diagnostics', protocolVersion: 1, time: new Date().toISOString(),
    environment: el<HTMLInputElement>('environment').value.trim(), stats,
    acknowledgement: { samples: ackTimes.length, p95Ms: percentile(ackTimes) },
    peerReceiptRoundTrip: { samples: deliveryTimes.length, p95Ms: percentile(deliveryTimes) },
    state: state ? { phase: state.phase, count: state.count, version: state.version, peers: state.peers,
      remainingMs: state.remainingMs, deadline: state.deadline, disconnectDeadline: state.disconnectDeadline } : null,
    observedInstances: bootIds.size, secureContext: isSecureContext,
    note: '人工网络与真机结果需另行确认；实例变化不能单独证明自然休眠；不含 Cookie、邀请链接或会话标识。',
  };
  void copy(JSON.stringify(report, null, 2));
};
setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) {
    if (performance.now() - lastServer >= HEALTH_MS) { ws.close(4000, 'server_silent'); return; }
    if (performance.now() - lastPing >= HEARTBEAT_MS) { lastPing = performance.now(); ws.send('ping'); }
  }
  for (const [id,p] of pending) if (performance.now() - p.sent > 15_000) {
    stats.uncertain++; pending.delete(id); stopSampling('有信号未确认，请恢复连接并核对持久化计数。');
  }
  if (!state) return;
  const estimatedNow = snapshotServer + performance.now() - snapshotAt;
  const ms = state.phase === 'running' && state.deadline !== null ? Math.max(0, state.deadline - estimatedNow) : state.remainingMs;
  el('timer').textContent = `${(ms / 1_000).toFixed(1)} 秒`;
  const names = { waiting: '等待双方连接后开始测试', running: ms > 0 ? '服务端计时中' : '等待服务端裁决', paused: '离线暂停，等待双方恢复同步', timeout: '服务端确认：60 秒计时结束', aborted: '服务端确认：离线等待超时，会话已中止，不判负', expired: '测试已过期' };
  el('phase').textContent = names[state.phase] + (state.disconnectDeadline ? `；等待剩余约 ${Math.max(0, Math.ceil((state.disconnectDeadline-estimatedNow)/1000))} 秒` : '');
}, 200);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !manual && room) void connect(); });
window.addEventListener('online', () => { if (!manual) void connect(); });
window.addEventListener('offline', () => { status('此设备已离线，网络恢复后自动重连'); ws?.close(); });
window.addEventListener('pagehide', () => { ws?.close(1000, 'page_hidden'); });
render(); if (room) void connect();
