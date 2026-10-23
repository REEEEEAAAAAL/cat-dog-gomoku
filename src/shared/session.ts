export const HEARTBEAT_MS = 5_000;
export const HEALTH_MS = 12_000;
export const OFFLINE_MS = 300_000;
export const TURN_MS = 60_000;
export type Phase = 'waiting' | 'running' | 'paused' | 'timeout' | 'aborted' | 'expired';
export type Seat = 0 | 1;
export interface Presence { online: boolean; synced: boolean }
export interface Session {
  phase: Phase;
  peers: [Presence, Presence];
  count: number;
  version: number;
  remainingMs: number;
  deadline: number | null;
  disconnectDeadline: number | null;
  expiresAt: number;
}
export function initial(now: number): Session {
  return { phase: 'waiting', peers: [{ online: false, synced: false }, { online: false, synced: false }],
    count: 0, version: 0, remainingMs: TURN_MS, deadline: null,
    disconnectDeadline: null, expiresAt: now + 86_400_000 };
}
export function settle(s: Session, now: number): void {
  if (now >= s.expiresAt) {
    s.phase = 'expired'; s.deadline = null; s.disconnectDeadline = null;
  } else if (s.phase === 'running' && s.deadline !== null && now >= s.deadline) {
    s.phase = 'timeout'; s.remainingMs = 0; s.deadline = null;
  } else if (s.phase === 'paused' && s.disconnectDeadline !== null && now >= s.disconnectDeadline) {
    s.phase = 'aborted'; s.disconnectDeadline = null;
  }
}
export function presence(s: Session, seat: Seat, online: boolean, synced: boolean, now: number): void {
  settle(s, now);
  s.peers[seat] = { online, synced: online && synced };
  const ready = s.peers.every(p => p.online && p.synced);
  if (s.phase === 'running' && !ready) {
    s.remainingMs = Math.max(0, (s.deadline ?? now) - now);
    s.deadline = null; s.phase = 'paused'; s.disconnectDeadline = now + OFFLINE_MS;
  } else if (s.phase === 'paused' && ready) {
    s.phase = 'running'; s.deadline = now + s.remainingMs; s.disconnectDeadline = null;
  }
}
export function start(s: Session, now: number): boolean {
  settle(s, now);
  if (s.phase === 'expired' || s.phase === 'running' || s.phase === 'paused'
    || !s.peers.every(p => p.online && p.synced)) return false;
  s.phase = 'running'; s.remainingMs = TURN_MS; s.deadline = now + TURN_MS;
  s.disconnectDeadline = null;
  return true;
}
export function nextAlarm(s: Session, health: number[]): number {
  return Math.min(s.expiresAt, s.deadline ?? Infinity, s.disconnectDeadline ?? Infinity, ...health);
}
export type Command =
  | { type: 'sync'; nonce: string }
  | { type: 'start'; id: string; version: number }
  | { type: 'pulse'; id: string; version: number }
  | { type: 'received'; id: string };
export function parseCommand(raw: string | ArrayBuffer): Command | null {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 1024) return null;
  try {
    const c: unknown = JSON.parse(raw);
    if (!c || typeof c !== 'object' || !('type' in c)) return null;
    if (c.type === 'sync' && 'nonce' in c && typeof c.nonce === 'string' && /^[a-f0-9-]{36}$/.test(c.nonce))
      return { type: 'sync', nonce: c.nonce };
    if ('id' in c && typeof c.id === 'string' && /^[a-f0-9-]{36}$/.test(c.id)) {
      if (c.type === 'received') return { type: 'received', id: c.id };
      if ((c.type === 'pulse' || c.type === 'start') && 'version' in c
        && Number.isSafeInteger(c.version) && Number(c.version) >= 0)
        return { type: c.type, id: c.id, version: Number(c.version) };
    }
  } catch { return null; }
  return null;
}
