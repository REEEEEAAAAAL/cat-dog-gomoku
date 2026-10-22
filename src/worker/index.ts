import { DurableObject } from 'cloudflare:workers';
import { HEALTH_MS, initial, nextAlarm, parseCommand, presence, settle, start, type Seat, type Session } from '../shared/session';
interface Attachment {
    seat: Seat;
    generation: string;
    nonce: string;
    connectedAt: number;
    lastSeen: number;
    rateAt: number;
    rateCount: number;
}
type StoredRow = {
    json: string;
};
const ROOM = /^\/api\/s\/([a-f0-9-]{36})\/(join|ws)$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const securityHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function reply(error: string, status = 400): Response {
    return Response.json({ error }, { status, headers: securityHeaders });
}
function cookie(request: Request): string {
    return request.headers.get('Cookie')?.match(/(?:^|;\s*)diag=([a-f0-9]{64})(?:;|$)/)?.[1] ?? '';
}
async function digest(value: string): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
export default {
    async fetch(request, env): Promise<Response> {
        const url = new URL(request.url);
        const route = ROOM.exec(url.pathname);
        if (!route || !uuid.test(route[1]))
            return reply('not_found', 404);
        if (request.headers.get('Origin') !== url.origin)
            return reply('origin_rejected', 403);
        if (route[2] === 'join' && request.method !== 'POST')
            return reply('method_rejected', 405);
        if (route[2] === 'ws' && (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'))
            return reply('websocket_required', 426);
        return env.DIAGNOSTICS.getByName(`diagnostics-v1:${route[1]}`).fetch(request);
    },
} satisfies ExportedHandler<Env>;
export class DiagnosticSession extends DurableObject<Env> {
    private bootId = crypto.randomUUID();
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS session (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL)');
        this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS seats (seat INTEGER PRIMARY KEY, hash TEXT NOT NULL, generation TEXT NOT NULL)');
        this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, seat INTEGER NOT NULL, fingerprint TEXT NOT NULL, count INTEGER NOT NULL, version INTEGER NOT NULL)');
        this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS schedule (id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL)');
        this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
    private read(): Session {
        const row = this.ctx.storage.sql.exec<StoredRow>('SELECT json FROM session WHERE id=1').toArray()[0];
        return row ? JSON.parse(row.json) as Session : initial(Date.now());
    }
    private current(ws: WebSocket): Attachment | null {
        const a = ws.deserializeAttachment() as Attachment | null;
        if (!a)
            return null;
        const row = this.ctx.storage.sql.exec<{
            generation: string;
        }>('SELECT generation FROM seats WHERE seat=?', a.seat).toArray()[0];
        return row?.generation === a.generation ? a : null;
    }
    private send(ws: WebSocket, data: object): void {
        try {
            ws.send(JSON.stringify(data));
        }
        catch { /* The health alarm reconciles failed transports. */ }
    }
    private snapshot(s: Session, extra: object = {}): object {
        return { type: 'snapshot', protocolVersion: 1, state: s, serverNow: Date.now(), bootId: this.bootId, ...extra };
    }
    private broadcast(s: Session, extra: object = {}): void {
        for (const ws of this.ctx.getWebSockets())
            if (this.current(ws))
                this.send(ws, this.snapshot(s, extra));
    }
    private reconcile(s: Session, now: number): void {
        settle(s, now);
        for (const ws of this.ctx.getWebSockets()) {
            const a = this.current(ws);
            if (!a)
                continue;
            const lastSeen = Math.max(a.connectedAt, a.lastSeen, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0);
            if (now >= lastSeen + HEALTH_MS || ws.readyState !== WebSocket.OPEN) {
                this.ctx.storage.sql.exec('UPDATE seats SET generation=? WHERE seat=?', crypto.randomUUID(), a.seat);
                presence(s, a.seat, false, false, now);
                ws.close(4000, 'heartbeat_timeout');
            }
        }
    }
    private async save(s: Session, before: string): Promise<void> {
        if (JSON.stringify(s) !== before) {
            s.version++;
            this.ctx.storage.sql.exec('INSERT INTO session(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json', JSON.stringify(s));
        }
        if (s.phase === 'expired') {
            for (const ws of this.ctx.getWebSockets())
                ws.close(4001, 'session_expired');
            this.ctx.storage.sql.exec('DELETE FROM seats');
            this.ctx.storage.sql.exec('DELETE FROM receipts');
            this.ctx.storage.sql.exec('DELETE FROM schedule');
            await this.ctx.storage.deleteAlarm();
            return;
        }
        const health = this.ctx.getWebSockets().flatMap(ws => {
            const a = this.current(ws);
            return a ? [Math.max(a.lastSeen, a.connectedAt, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0) + HEALTH_MS] : [];
        });
        const alarm = nextAlarm(s, health);
        this.ctx.storage.sql.exec('INSERT INTO schedule(id,at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at', alarm);
        await this.ctx.storage.setAlarm(alarm);
    }
    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const token = cookie(request);
        const hash = token ? await digest(token) : '';
        const fresh = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
        const freshHash = await digest(fresh);
        const s = this.read();
        const before = JSON.stringify(s);
        const now = Date.now();
        this.reconcile(s, now);
        if (s.phase === 'expired') {
            await this.save(s, before);
            return reply('session_expired', 410);
        }
        const seat = this.ctx.storage.sql.exec<{
            seat: Seat;
        }>('SELECT seat FROM seats WHERE hash=?', hash).toArray()[0]?.seat;
        if (url.pathname.endsWith('/join')) {
            if (seat !== undefined) {
                await this.save(s, before);
                return Response.json({ seat }, { headers: securityHeaders });
            }
            const seats = this.ctx.storage.sql.exec('SELECT seat FROM seats').toArray();
            if (seats.length >= 2) {
                await this.save(s, before);
                return reply('session_full', 409);
            }
            const next = seats.length as Seat;
            this.ctx.storage.sql.exec('INSERT INTO seats(seat,hash,generation) VALUES(?,?,?)', next, freshHash, crypto.randomUUID());
            await this.save(s, '');
            return Response.json({ seat: next }, { headers: { ...securityHeaders,
                    'Set-Cookie': `diag=${fresh}; HttpOnly; SameSite=Strict; Path=${url.pathname.slice(0, -4)}; Max-Age=86400${url.protocol === 'https:' ? '; Secure' : ''}` } });
        }
        if (seat === undefined) {
            await this.save(s, before);
            return reply('unauthorized', 401);
        }
        presence(s, seat, true, false, now);
        const generation = crypto.randomUUID();
        this.ctx.storage.sql.exec('UPDATE seats SET generation=? WHERE seat=?', generation, seat);
        for (const old of this.ctx.getWebSockets()) {
            if ((old.deserializeAttachment() as Attachment).seat === seat)
                old.close(4002, 'replaced');
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        const a: Attachment = { seat, generation, nonce: crypto.randomUUID(), connectedAt: now, lastSeen: now, rateAt: now, rateCount: 0 };
        server.serializeAttachment(a);
        await this.save(s, before);
        this.send(server, this.snapshot(s, { seat, nonce: a.nonce }));
        this.broadcast(s);
        return new Response(null, { status: 101, webSocket: client });
    }
    async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
        const s = this.read();
        const before = JSON.stringify(s);
        const now = Date.now();
        this.reconcile(s, now);
        const a = this.current(ws);
        if (!a) {
            await this.save(s, before);
            ws.close(4002, 'stale_connection');
            return;
        }
        const c = parseCommand(raw);
        if (!c) {
            await this.save(s, before);
            this.send(ws, { type: 'error', error: 'invalid_message' });
            return;
        }
        if (now - a.rateAt >= 1000) {
            a.rateAt = now;
            a.rateCount = 0;
        }
        if (++a.rateCount > 12) {
            ws.serializeAttachment(a);
            await this.save(s, before);
            ws.close(4003, 'rate_limited');
            return;
        }
        a.lastSeen = now;
        ws.serializeAttachment(a);
        let extra: object = {};
        let persistedBefore = before;
        if (c.type === 'sync') {
            if (c.nonce !== a.nonce) {
                await this.save(s, before);
                this.send(ws, { type: 'error', error: 'sync_rejected' });
                return;
            }
            presence(s, a.seat, true, true, now);
        }
        else if (!s.peers[a.seat].synced) {
            await this.save(s, before);
            this.send(ws, { type: 'error', error: 'sync_required' });
            return;
        }
        else if (c.type === 'received') {
            const receipt = this.ctx.storage.sql.exec<{
                seat: Seat;
            }>('SELECT seat FROM receipts WHERE id=?', c.id).toArray()[0];
            await this.save(s, before);
            if (receipt && receipt.seat !== a.seat)
                this.broadcast(s, { delivered: c.id });
            return;
        }
        else {
            const fingerprint = JSON.stringify({ type: c.type, version: c.version });
            const receipt = this.ctx.storage.sql.exec<{
                seat: Seat;
                fingerprint: string;
            }>('SELECT seat,fingerprint FROM receipts WHERE id=?', c.id).toArray()[0];
            if (receipt) {
                await this.save(s, before);
                this.send(ws, this.snapshot(s, receipt.seat === a.seat && receipt.fingerprint === fingerprint ? { ack: c.id, duplicate: true } : { error: 'id_conflict' }));
                return;
            }
            if (s.phase === 'expired' || c.version !== s.version || !s.peers.every(p => p.online && p.synced)) {
                await this.save(s, before);
                this.send(ws, this.snapshot(s, { error: 'state_conflict', rejected: c.id }));
                return;
            }
            if (c.type === 'start') {
                if (!start(s, now)) {
                    await this.save(s, before);
                    this.send(ws, this.snapshot(s, { error: 'timer_unavailable', rejected: c.id }));
                    return;
                }
            }
            else
                s.count++;
            this.ctx.storage.transactionSync(() => {
                s.version++;
                this.ctx.storage.sql.exec('INSERT INTO session(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json', JSON.stringify(s));
                this.ctx.storage.sql.exec('INSERT INTO receipts(id,seat,fingerprint,count,version) VALUES(?,?,?,?,?)', c.id, a.seat, fingerprint, s.count, s.version);
                this.ctx.storage.sql.exec('DELETE FROM receipts WHERE id IN (SELECT id FROM receipts ORDER BY rowid DESC LIMIT -1 OFFSET 512)');
            });
            persistedBefore = JSON.stringify(s);
            extra = { ack: c.id, from: a.seat, action: c.type };
        }
        await this.save(s, persistedBefore);
        this.broadcast(s, extra);
    }
    async webSocketClose(ws: WebSocket): Promise<void> { await this.disconnect(ws); }
    async webSocketError(ws: WebSocket): Promise<void> { await this.disconnect(ws); }
    private async disconnect(ws: WebSocket): Promise<void> {
        const a = this.current(ws);
        if (!a)
            return;
        const s = this.read();
        const before = JSON.stringify(s);
        this.reconcile(s, Date.now());
        this.ctx.storage.sql.exec('UPDATE seats SET generation=? WHERE seat=?', crypto.randomUUID(), a.seat);
        presence(s, a.seat, false, false, Date.now());
        await this.save(s, before);
        this.broadcast(s);
    }
    async alarm(info?: AlarmInvocationInfo): Promise<void> {
        const s = this.read();
        const before = JSON.stringify(s);
        const scheduled = this.ctx.storage.sql.exec<{
            at: number;
        }>('SELECT at FROM schedule WHERE id=1').toArray()[0]?.at;
        this.reconcile(s, Date.now());
        await this.save(s, before);
        this.broadcast(s, { alarm: { at: Date.now(), delayMs: scheduled === undefined ? null : Math.max(0, Date.now() - scheduled), retry: info?.retryCount ?? 0 } });
    }
}
