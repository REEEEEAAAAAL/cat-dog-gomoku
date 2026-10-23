import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Action, Reply, Snapshot } from '../src/game/protocol';
import type { Move, Seat } from '../src/game/rules';

let db: PGlite;
let room: string;
let current: Snapshot;
let caller: Seat;
const clients = [crypto.randomUUID(), crypto.randomUUID()];
const baseTime = Date.parse('2026-10-23T02:00:00Z');
async function time(ms = 0) { await db.query("SELECT set_config('test.now',$1,false)", [new Date(baseTime + ms).toISOString()]); }
async function user(uid: string, role = 'authenticated') {
  await db.query("SELECT set_config('request.uid',$1,false),set_config('request.role',$2,false)", [uid, role]);
}
async function as(seat: Seat) { caller = seat; await user(`player-${seat}-${room}`); }
async function call(action: Action, data: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): Promise<Reply> {
  const params = { room, action, client: clients[caller - 1], operation: crypto.randomUUID(), version: current?.version ?? 0,
    game: current?.gameId ?? null, data, protocol: 1, ...overrides };
  const result = await db.query<{ reply: Reply }>('SELECT public.gomoku_command($1,$2,$3,$4,$5,$6,$7,$8) AS reply',
    [params.room, params.action, params.client, params.operation, params.version, params.game, params.data, params.protocol]);
  const reply = result.rows[0].reply;
  if (!reply.pending) current = reply;
  return reply;
}
async function sync() { await call('sync'); }
async function start() {
  await as(2); expect((await call('apply', { name: '猫猫' })).pending).toBe(true);
  await as(1); await call('snapshot'); await call('approve', { application: current.application?.id });
  await as(2); await call('connect'); await sync(); await call('ready');
  await as(1); await call('snapshot'); await call('ready'); expect(current.phase).toBe('running');
}
async function seed(moves: Move[], turn: Seat) {
  await db.query('UPDATE public.gomoku_rooms SET moves=$1,turn_seat=$2 WHERE id=$3', [JSON.stringify(moves), turn, room]);
  await as(turn); await call('snapshot');
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS text LANGUAGE SQL AS $$ SELECT nullif(current_setting('request.uid',true),'') $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE SQL AS $$ SELECT current_setting('request.role',true) $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE SQL AS $$ SELECT jsonb_build_object('is_anonymous',current_setting('request.visitor',true)='true') $$;
    CREATE FUNCTION public.test_now() RETURNS timestamptz LANGUAGE SQL AS $$ SELECT current_setting('test.now')::timestamptz $$;
    GRANT USAGE ON SCHEMA public,auth TO authenticated,anon;`);
  await time();
  const migration = await readFile('cloudbase/migrations/20261023010000_gomoku_mvp.sql', 'utf8');
  await db.exec(migration.replaceAll('clock_timestamp()', 'public.test_now()'));
  const extras = await readFile('cloudbase/migrations/20261023020000_undo_and_reactions.sql', 'utf8');
  await db.exec(extras.replaceAll('clock_timestamp()', 'public.test_now()'));
  const lifecycle = await readFile('cloudbase/migrations/20261023030000_application_lifecycle.sql', 'utf8');
  await db.exec(lifecycle.replaceAll('clock_timestamp()', 'public.test_now()'));
  const feedback = await readFile('cloudbase/migrations/20261023040000_interaction_feedback.sql', 'utf8');
  await db.exec(feedback.replaceAll('clock_timestamp()', 'public.test_now()'));
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec('RESET ROLE'); await time(); room = crypto.randomUUID(); await as(1);
  await call('create', { name: '狗狗', animal: 'dog' }); await sync();
});

describe('game RPC on isolated PostgreSQL with controlled server clock', () => {
  it('requires native identity and a signed anonymous visitor claim', async () => {
    await user('', 'anon'); await expect(call('snapshot')).rejects.toThrow('unauthorized');
    await user(`player-1-${room}`, 'anon'); await expect(call('snapshot')).rejects.toThrow('unauthorized');
    await db.exec("SELECT set_config('request.visitor','true',false); SET ROLE anon");
    expect((await call('snapshot')).pending).toBe(false);
  });
  it('keeps applicants and third visitors away from board and requires host approval', async () => {
    await as(2); const pending = await call('apply', { name: '<猫>' });
    expect(pending).not.toHaveProperty('moves'); expect(pending).not.toHaveProperty('players');
    await expect(call('ready')).rejects.toThrow('forbidden');
    await user('outsider'); await expect(call('snapshot')).rejects.toThrow('forbidden');
    await expect(call('apply', { name: '三号' })).rejects.toThrow('application_pending');
    await as(1); await call('snapshot'); await call('reject', { application: current.application?.id });
    await as(2); await expect(call('snapshot')).rejects.toThrow('forbidden');
    await start(); await user('outsider'); await expect(call('apply', { name: '三号' })).rejects.toThrow('room_full');
  });
  it('denies direct table reads and writes to browser roles', async () => {
    await db.exec('SET ROLE authenticated');
    await expect(db.query('SELECT * FROM public.gomoku_rooms')).rejects.toThrow('permission denied');
    await expect(db.query('UPDATE public.gomoku_rooms SET version=900')).rejects.toThrow('permission denied');
    expect((await call('snapshot')).pending).toBe(false);
  });
  it('reads a pending application without modifying its ID or recreating a rejected request', async () => {
    await as(2); const applied = await call('apply', { name: '猫猫' });
    expect(applied.pending).toBe(true);
    if (!applied.pending) throw new Error('Expected an application');
    for (let i = 0; i < 3; i++) expect(await call('snapshot')).toMatchObject({ pending: true, applicationId: applied.applicationId });
    await as(1); await call('snapshot'); const version = current.version;
    await call('reject', { application: applied.applicationId }); expect(current.version).toBe(version + 1);
    await as(2); await expect(call('snapshot')).rejects.toThrow('forbidden');
    await as(1); await call('snapshot'); expect(current.application).toBeNull();
  });
  it('withdraws idempotently and does not erase another visitor application', async () => {
    await as(2); const applied = await call('apply', { name: '猫猫' });
    if (!applied.pending) throw new Error('Expected an application');
    const data = { application: applied.applicationId };
    expect(await call('withdraw', data)).toMatchObject({ pending: true, withdrawn: true, applicationId: null });
    expect(await call('withdraw', data)).toMatchObject({ withdrawn: true });
    await user('third'); const third = await call('apply', { name: '第三位' });
    await as(2); await call('withdraw', data);
    await as(1); await call('snapshot');
    expect(current.application?.name).toBe('第三位');
    if (!third.pending) throw new Error('Expected an application');
    expect(current.application?.id).toBe(third.applicationId);
  });
  it('rejects a stale withdrawal after the same visitor explicitly reapplies', async () => {
    await as(2); const first = await call('apply', { name: '猫猫' });
    if (!first.pending) throw new Error('Expected an application');
    await as(1); await call('snapshot'); await call('reject', { application: first.applicationId });
    await as(2); const next = await call('apply', { name: '猫猫' });
    if (!next.pending) throw new Error('Expected an application');
    await expect(call('withdraw', { application: first.applicationId })).rejects.toThrow('application_changed');
    expect((await call('snapshot'))).toMatchObject({ applicationId: next.applicationId });
  });
  it('keeps an approved seat during a withdrawal race and requires an explicit control connection', async () => {
    await as(2); const applied = await call('apply', { name: '猫猫' });
    if (!applied.pending) throw new Error('Expected an application');
    await as(1); await call('snapshot'); await call('approve', { application: applied.applicationId });
    await as(2); await expect(call('withdraw', { application: applied.applicationId })).rejects.toThrow('application_changed');
    await expect(call('snapshot')).rejects.toThrow('connect_required');
    await call('connect'); await sync(); expect(current.seat).toBe(2); expect(current.players[1].synced).toBe(true);
    await user('third'); await expect(call('apply', { name: '第三位' })).rejects.toThrow('room_full');
  });
  it('starts only after both players are ready, online and synchronized', async () => {
    expect(current.phase).toBe('waiting'); await start();
    expect(current).toMatchObject({ remainingMs: 60000, turnSeat: current.blackSeat, round: 1 });
    expect(current.players.map(p => p.animal)).toEqual(['dog', 'cat']);
  });
  it('validates turn, integer bounds, occupied points, game and protocol', async () => {
    await start(); await as((3 - current.turnSeat) as Seat); await call('move', { x: 7, y: 7 });
    expect(current.rejection).toBe('not_your_turn');
    await as(current.turnSeat);
    for (const x of [-1, 15, 1.5, '7', null]) { await call('move', { x, y: 7 }); expect(current.rejection).toBe('invalid_position'); }
    await call('move', { x: 7, y: 7 }); expect(current.accepted).toBe(true);
    await as(current.turnSeat); await call('move', { x: 7, y: 7 }); expect(current.rejection).toBe('occupied');
    await call('move', { x: 8, y: 7 }, { game: crypto.randomUUID() }); expect(current.rejection).toBe('old_game');
    await expect(call('snapshot', {}, { protocol: 2 })).rejects.toThrow('protocol_mismatch');
  });
  it('deduplicates lost acknowledgements and rejects operation ID reuse and stale simultaneous requests', async () => {
    await start(); await as(current.turnSeat);
    const operation = crypto.randomUUID(), version = current.version, game = current.gameId;
    await call('move', { x: 0, y: 0 }, { operation, version, game });
    const deadline = current.turnDeadline;
    await time(4000); await call('move', { x: 0, y: 0 }, { operation, version, game });
    expect(current).toMatchObject({ duplicate: true, accepted: true, turnDeadline: deadline }); expect(current.moves).toHaveLength(1);
    await expect(call('move', { x: 1, y: 0 }, { operation, version, game })).rejects.toThrow('id_conflict');
    await as(current.turnSeat); await call('move', { x: 1, y: 0 }, { version });
    expect(current.rejection).toBe('state_conflict'); expect(current.moves).toHaveLength(1);
  });
  it.each([[1, 0, 0, 0], [0, 1, 14, 0], [1, 1, 0, 0], [1, -1, 0, 14]])('judges a five in direction %s,%s at an edge', async (dx, dy, x, y) => {
    await start(); const seat = current.blackSeat;
    await seed(Array.from({ length: 4 }, (_, i) => ({ x: x + i * dx, y: y + i * dy, seat, color: 1 })), seat);
    await call('move', { x: x + 4 * dx, y: y + 4 * dy });
    expect(current).toMatchObject({ phase: 'finished', reason: 'five', winner: seat }); expect(current.winLine).toHaveLength(5);
    await call('move', { x: 10, y: 10 }); expect(current.rejection).toBe('not_running');
  });
  it('accepts six-stone overlines', async () => {
    await start(); const seat = current.blackSeat;
    await seed([0, 1, 2, 4, 5].map(x => ({ x, y: 7, seat, color: 1 })), seat);
    await call('move', { x: 3, y: 7 }); expect(current.winLine).toHaveLength(6);
  });
  it.each([false, true])('adjudicates a full board with win precedence: %s', async win => {
    await start(); const last = { x: 14, y: 14 };
    const moves: Move[] = Array.from({ length: 225 }, (_, i) => {
      const x = i % 15, y = Math.floor(i / 15);
      const color: Seat = win && y === 14 && x >= 10 ? 1 : (Math.floor(x / 2) + y) % 2 === 0 ? 1 : 2;
      return { x, y, color, seat: color === 1 ? current.blackSeat : (3 - current.blackSeat) as Seat };
    });
    const turn = moves[224].seat; await seed(moves.slice(0, -1), turn); await call('move', last);
    expect(current).toMatchObject({ phase: 'finished', reason: win ? 'five' : 'draw', winner: win ? turn : null });
  });
  it('gives exactly 60 seconds after a valid move and keeps deadlines on invalid requests', async () => {
    await start(); await time(12000); await as(current.turnSeat); await call('move', { x: 2, y: 3 });
    expect(current.turnDeadline).toBe(baseTime + 72000); expect(current.remainingMs).toBe(60000);
    await time(14000); await call('move', { x: 4, y: 3 }); expect(current.turnDeadline).toBe(baseTime + 72000);
  });
  it.each([59999, 60000, 60001])('uses server time at the deadline: %s', async ms => {
    await start();
    for (const ms of [10000, 20000, 30000, 40000, 50000]) { await time(ms); await as(1); await call('snapshot'); await as(2); await call('snapshot'); }
    await time(ms); await as(current.turnSeat); const turn = current.turnSeat; await call('move', { x: 2, y: 3 });
    if (ms < 60000) expect(current.moves).toHaveLength(1);
    else expect(current).toMatchObject({ phase: 'finished', reason: 'timeout', winner: 3 - turn, moves: [] });
  });
  it('pauses after a missed heartbeat, rejects play, then requires the returning player to acknowledge synchronization', async () => {
    await start(); await time(26000); await as(2); await call('snapshot');
    expect(current).toMatchObject({ phase: 'paused', remainingMs: 45000, offlineDeadline: baseTime + 315000 });
    await call('move', { x: 0, y: 0 }); expect(current.rejection).toBe('sync_required'); await sync();
    await time(100000); await call('snapshot'); await sync(); const deadline = current.offlineDeadline;
    await as(1); await call('connect'); expect(current.offlineDeadline).toBe(deadline);
    await sync(); expect(current).toMatchObject({ phase: 'running', remainingMs: 45000, turnDeadline: baseTime + 145000 });
  });
  it('tolerates two missed polls and pauses at exactly fifteen seconds', async () => {
    await start(); await time(14999); await as(1); await call('snapshot');
    expect(current.phase).toBe('running');
    await time(15000); await call('snapshot');
    expect(current).toMatchObject({ phase: 'paused', remainingMs: 45000, offlineDeadline: baseTime + 315000 });
  });
  it.each([314999, 315000, 315001])('honors the fixed five-minute reconnect boundary: %s', async ms => {
    await start(); await time(26000); await as(2); await call('snapshot');
    await time(ms); await call('connect'); await sync(); await as(1); await call('connect'); await sync();
    if (ms < 315000) expect(current.phase).toBe('running');
    else expect(current).toMatchObject({ phase: 'finished', reason: 'disconnect_timeout', winner: null });
  });
  it('settles both-offline rooms lazily without reviving an old game', async () => {
    await start(); await time(400000); await as(1); await call('connect');
    expect(current).toMatchObject({ phase: 'finished', reason: 'disconnect_timeout', winner: null });
  });
  it('pauses on refresh, prevents an old tab controlling a seat and preserves the original reconnect window', async () => {
    await start(); const old = clients[0]; await time(10000); await as(1);
    const replacement = crypto.randomUUID(); await call('connect', {}, { client: replacement });
    expect(current).toMatchObject({ phase: 'paused', remainingMs: 50000 });
    const deadline = current.offlineDeadline;
    await expect(call('snapshot', {}, { client: old })).rejects.toThrow('superseded');
    await time(20000); await as(2); await call('snapshot'); await sync(); await as(1); await call('connect', {}, { client: replacement }); expect(current.offlineDeadline).toBe(deadline);
    await call('sync', {}, { client: replacement }); expect(current).toMatchObject({ phase: 'running', remainingMs: 50000 });
  });
  it.each(['five', 'timeout', 'disconnect_timeout'])('requires two rematch votes and swaps colors after %s', async reason => {
    await start(); const black = current.blackSeat, game = current.gameId;
    await db.query("UPDATE public.gomoku_rooms SET phase='finished',reason=$1,turn_deadline=NULL WHERE id=$2", [reason, room]);
    await as(1); await call('snapshot'); await call('rematch'); expect(current.phase).toBe('finished');
    await as(2); await call('snapshot'); await call('rematch');
    expect(current).toMatchObject({ phase: 'running', round: 2, blackSeat: 3 - black, remainingMs: 60000, moves: [] });
    expect(current.gameId).not.toBe(game);
    await call('move', { x: 1, y: 1 }, { game }); expect(current.rejection).toBe('old_game');
  });
  it('expires rooms and closes on an explicit leave without releasing seats', async () => {
    await start(); await call('leave'); expect(current).toMatchObject({ phase: 'closed', reason: 'left', winner: null });
    await call('move', { x: 0, y: 0 }); expect(current.rejection).toBe('room_closed');
    await time(86400000); await expect(call('snapshot')).rejects.toThrow('expired');
  });

  async function alive(ms: number) {
    await time(ms);
    await db.exec('UPDATE public.gomoku_rooms SET owner_seen_at=public.test_now(),guest_seen_at=public.test_now()');
  }
  async function requestUndo() {
    const index = current.moves.findLastIndex(m => m.seat === caller);
    await call('undo_request', { target: current.moves[index]?.id ?? `legacy-${index}` });
    return current.undoRequest!;
  }
  async function moveFirst(ms = 0) {
    await start(); await alive(ms); await as(current.turnSeat); const first = caller;
    await call('move', { x: 7, y: 7 }); return first;
  }
  it.each([1, 2])('undo removes the correct %s latest stones and restores the requester turn', async count => {
    const first = await moveFirst(22000);
    if (count === 2) { await as(current.turnSeat); await call('move', { x: 8, y: 8 }); }
    await as(first); await call('snapshot'); const request = await requestUndo();
    expect(current.phase).toBe('paused'); expect(request).toMatchObject({ removeCount: count, restoreMs: 38000, seat: first });
    await as((3 - first) as Seat); await call('snapshot');
    const operation = crypto.randomUUID(), version = current.version, game = current.gameId;
    await call('undo_respond', { request: request.id, accept: true }, { operation, version, game });
    expect(current).toMatchObject({ phase: 'running', turnSeat: first, remainingMs: 38000, moves: [], undoRequest: null });
    expect(current.players[first - 1].undoLeft).toBe(1);
    await call('undo_respond', { request: request.id, accept: true }, { operation, version, game });
    expect(current.duplicate).toBe(true); expect(current.players[first - 1].undoLeft).toBe(1);
  });
  it.each([3000, 15000, 38000, 60000])('undo restores a clamped %s ms budget', async remainder => {
    const first = await moveFirst(60000 - remainder); const request = await requestUndo();
    expect(request.restoreMs).toBe(Math.max(15000, remainder));
    await as((3 - first) as Seat); await call('snapshot'); await call('undo_respond', { request: request.id, accept: true });
    expect(current.remainingMs).toBe(Math.max(15000, remainder));
  });
  it.each(['reject', 'cancel', 'expire'])('undo %s resumes the exact frozen budget without consuming a use and blocks re-requesting the same move', async finish => {
    const first = await moveFirst(); await alive(4000); const request = await requestUndo();
    const turn = current.turnSeat, remaining = current.remainingMs;
    if (finish === 'reject') {
      await as((3 - first) as Seat); await call('snapshot'); await call('undo_respond', { request: request.id, accept: false });
    } else if (finish === 'cancel') await call('undo_cancel', { request: request.id });
    else { await alive(34000); await call('snapshot'); }
    expect(current).toMatchObject({ phase: 'running', turnSeat: turn, remainingMs: remaining, undoRequest: null });
    expect(current.players[first - 1].undoLeft).toBe(2);
    await as(first); await call('snapshot'); await requestUndo(); expect(current.rejection).toBe('undo_already_requested');
    expect(current.undoBlocked).toBe(true);
    expect(current.undoDenied?.id ?? null).toBe(finish === 'reject' ? request.id : null);
  });
  it('persists refusal only for the requester and allows a later distinct target after cooldown', async () => {
    const first = await moveFirst(); const request = await requestUndo();
    await as((3 - first) as Seat); await call('snapshot'); await call('undo_respond', { request: request.id, accept: false });
    expect(current.undoDenied).toBeNull();
    await as(first); await call('connect'); await sync();
    expect(current.undoDenied).toMatchObject({ id: request.id, target: request.target });
    expect(current.undoBlocked).toBe(true);
    await as(current.turnSeat); await call('snapshot'); await call('move', { x: 8, y: 8 });
    await as(first); await call('snapshot'); await call('move', { x: 6, y: 6 });
    expect(current.undoBlocked).toBe(false);
    await alive(30000); await requestUndo(); expect(current.accepted).toBe(true);
    expect(current.undoRequest?.target).not.toBe(request.target);
    expect(current.undoDenied).toBeNull();
  });
  it('undo is limited to two successes and enforces a thirty-second request cooldown', async () => {
    const first = await moveFirst(); let request = await requestUndo();
    await as((3 - first) as Seat); await call('snapshot'); await call('undo_respond', { request: request.id, accept: true });
    await as(first); await call('snapshot'); await call('move', { x: 6, y: 6 }); await requestUndo();
    expect(current.rejection).toBe('undo_cooldown');
    await alive(30000); await requestUndo(); request = current.undoRequest!;
    await as((3 - first) as Seat); await call('snapshot'); await call('undo_respond', { request: request.id, accept: true });
    await as(first); await call('snapshot'); await call('move', { x: 5, y: 5 }); await requestUndo();
    expect(current.rejection).toBe('undo_limit'); expect(current.players[first - 1].undoLeft).toBe(0);
  });
  it('blocks moves during negotiation and prevents self-approval or opponent cancellation', async () => {
    const first = await moveFirst(); const request = await requestUndo();
    await call('undo_respond', { request: request.id, accept: true }); expect(current.rejection).toBe('forbidden');
    await as((3 - first) as Seat); await call('snapshot');
    await call('undo_cancel', { request: request.id }); expect(current.rejection).toBe('forbidden');
    await call('move', { x: 6, y: 6 }); expect(current.rejection).toBe('not_running');
  });
  it('cancels undo on detected disconnect and does not restore a time bonus on reconnect', async () => {
    const first = await moveFirst(20000); await alive(24000); await requestUndo(); const frozen = current.remainingMs;
    await time(50000); await as((3 - first) as Seat); await call('snapshot');
    expect(current).toMatchObject({ phase: 'paused', undoRequest: null, remainingMs: frozen });
    const deadline = current.offlineDeadline; expect(deadline).toBe(baseTime + 339000);
    await sync(); await as(first); await call('connect'); await sync();
    expect(current).toMatchObject({ phase: 'running', remainingMs: frozen });
    await requestUndo(); expect(current.rejection).toBe('undo_already_requested');
  });
  it('keeps the pending request across a short refresh and does not resume until negotiation completes', async () => {
    const first = await moveFirst(); const request = await requestUndo();
    await time(3000); await call('connect'); await sync();
    expect(current).toMatchObject({ phase: 'paused', undoRequest: { id: request.id }, offlineDeadline: null });
    await as((3 - first) as Seat); await call('snapshot'); await call('undo_respond', { request: request.id, accept: false });
    expect(current.phase).toBe('running');
  });
  it('rejects undo before a first move, after timeout, and against a stale target/version', async () => {
    await start(); await as(current.turnSeat); await call('undo_request', { target: 'missing' }); expect(current.rejection).toBe('no_undo_move');
    await call('move', { x: 7, y: 7 }); await call('undo_request', { target: 'missing' }); expect(current.rejection).toBe('undo_target_changed');
    await call('undo_request', { target: current.moves[0].id }, { version: current.version - 1 }); expect(current.rejection).toBe('state_conflict');
    await alive(60000); await call('snapshot'); await requestUndo(); expect(current.rejection).toBe('not_running');
  });
  it('emoji does not change turn, version or deadlines and remains usable during undo', async () => {
    await moveFirst(); const request = await requestUndo();
    const version = current.version, remaining = current.remainingMs;
    await call('emoji', { emoji: 'heart' });
    expect(current).toMatchObject({ phase: 'paused', version, remainingMs: remaining, undoRequest: { id: request.id } });
    expect(current.emojis).toHaveLength(1); expect(current.emojis[0].emoji).toBe('heart');
  });
  it('enforces the emoji whitelist, two-second cooldown, per-minute rate and idempotency', async () => {
    await start(); await call('emoji', { emoji: '<script>' }); expect(current.rejection).toBe('invalid_emoji');
    const operation = crypto.randomUUID(), version = current.version, game = current.gameId;
    await call('emoji', { emoji: 'heart' }, { operation, version, game });
    await call('emoji', { emoji: 'heart' }, { operation, version, game }); expect(current.emojis).toHaveLength(1);
    await call('emoji', { emoji: 'cat' }); expect(current.rejection).toBe('emoji_rate_limit');
    for (let i = 1; i < 10; i++) { await alive(i * 2000); await call('emoji', { emoji: 'laugh' }); expect(current.accepted).toBe(true); }
    await alive(20000); await call('emoji', { emoji: 'cat' }); expect(current.rejection).toBe('emoji_rate_limit');
    await alive(60000); await call('emoji', { emoji: 'cat' });
    expect(current.reason).toBe('timeout');
  });
});
