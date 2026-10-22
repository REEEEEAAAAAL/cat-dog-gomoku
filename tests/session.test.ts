import { describe, expect, it } from 'vitest';
import { initial, nextAlarm, OFFLINE_MS, parseCommand, presence, settle, start } from '../src/shared/session';

function running() {
  const s = initial(0); presence(s, 0, true, true, 0); presence(s, 1, true, true, 0);
  expect(start(s, 0)).toBe(true); return s;
}
describe('authoritative diagnostic timer', () => {
  it('requires both synchronized clients and starts exactly 60 seconds', () => {
    const s = initial(0); expect(start(s, 0)).toBe(false);
    expect(running().deadline).toBe(60_000);
  });
  it.each([59_999, 60_000, 60_001])('adjudicates deadline at %d', now => {
    const s = running(); settle(s, now); expect(s.phase).toBe(now < 60_000 ? 'running' : 'timeout');
  });
  it('retains 40 seconds through a two minute pause, requiring both sync acknowledgements', () => {
    const s = running(); presence(s, 0, false, false, 20_000);
    expect(s.remainingMs).toBe(40_000); expect(s.disconnectDeadline).toBe(320_000);
    presence(s, 1, false, false, 30_000); presence(s, 0, true, true, 140_000);
    presence(s, 1, true, false, 140_000); expect(s.phase).toBe('paused');
    presence(s, 1, true, true, 140_000); expect(s.phase).toBe('running'); expect(s.deadline).toBe(180_000);
  });
  it.each([OFFLINE_MS-1, OFFLINE_MS, OFFLINE_MS+1])('honors offline boundary %d without reviving the session', elapsed => {
    const s = running(); presence(s, 0, false, false, 20_000);
    presence(s, 0, true, true, 20_000 + elapsed);
    expect(s.phase).toBe(elapsed < OFFLINE_MS ? 'running' : 'aborted');
    if (elapsed >= OFFLINE_MS) { settle(s, 900_000); expect(s.phase).toBe('aborted'); expect(s.remainingMs).toBe(40_000); }
  });
  it('replacement and repeated sync cannot extend the original disconnect deadline', () => {
    const s = running(); presence(s, 0, true, false, 10_000);
    expect(s.phase).toBe('paused'); const deadline = s.disconnectDeadline;
    presence(s, 1, false, false, 40_000); presence(s, 0, true, false, 100_000);
    expect(s.disconnectDeadline).toBe(deadline);
  });
  it('delayed detection settles turn timeout before disconnect and repeated alarms are idempotent', () => {
    const s = running(); presence(s, 0, false, false, 60_010);
    expect(s.phase).toBe('timeout'); settle(s, 400_000); expect(s.phase).toBe('timeout');
  });
  it('reconstruction retains deadlines and a stale alarm cannot end a later timer', () => {
    const s = running(); settle(s, 60_000); expect(start(s, 70_000)).toBe(true);
    const recovered = JSON.parse(JSON.stringify(s)) as typeof s;
    settle(recovered, 70_001); expect(recovered.deadline).toBe(130_000); expect(recovered.phase).toBe('running');
  });
  it('shares one alarm across health, turn, disconnect and expiry without polling stale sockets', () => {
    const s = running(); expect(nextAlarm(s, [12_000, 13_000])).toBe(12_000);
    presence(s, 0, false, false, 20_000); presence(s, 1, false, false, 20_000);
    expect(nextAlarm(s, [])).toBe(320_000);
    settle(s, 320_000); expect(nextAlarm(s, [])).toBe(s.expiresAt);
  });
  it('room expiry takes precedence over a longer disconnect wait', () => {
    const s = running(); s.expiresAt = 25_000; presence(s, 0, false, false, 20_000);
    settle(s, 25_000); expect(s.phase).toBe('expired');
  });
});
describe('bounded protocol', () => {
  it('rejects malformed, binary, oversized and unknown messages', () => {
    for (const raw of ['ping', '{', JSON.stringify({ type:'ping', at:1 }), 'x'.repeat(1025), new ArrayBuffer(10)]) expect(parseCommand(raw)).toBeNull();
  });
  it('validates operation and version fields', () => {
    const id = crypto.randomUUID();
    expect(parseCommand(JSON.stringify({ type:'pulse', id, version: 1 }))).toEqual({ type:'pulse', id, version:1 });
    for (const version of [-1, 1.5, '2', null]) expect(parseCommand(JSON.stringify({ type:'pulse', id, version }))).toBeNull();
  });
});
