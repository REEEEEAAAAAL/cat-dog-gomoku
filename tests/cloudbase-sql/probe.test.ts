import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

let db:PGlite;
let legacyRoom:string;
beforeEach(async()=>{
  db=new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS text LANGUAGE SQL STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'') $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE SQL STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE SQL STABLE AS $$ SELECT jsonb_build_object('is_anonymous',current_setting('request.jwt.claim.is_anonymous',true) = 'true') $$;
    GRANT USAGE ON SCHEMA auth, public TO authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;`);
  await db.exec(await readFile('cloudbase/migrations/20261022123000_diagnostic_probe.sql','utf8'));
  await db.exec(await readFile('cloudbase/migrations/20261022130000_diagnostic_visitors.sql','utf8'));
  legacyRoom=crypto.randomUUID();
  await db.query(`INSERT INTO public.gomoku_diag_probe(id,owner,guest,count,version,receipts)
    VALUES($1,'legacy-owner','legacy-guest',7,9,'[]'::jsonb)`,[legacyRoom]);
  await db.exec(await readFile('cloudbase/migrations/20261022151600_diagnostic_timer.sql','utf8'));
});
afterEach(async()=>{await db.close();});
async function user(uid:string,role='authenticated'){await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)",[uid,role]);}
interface ProbeReply{count:number;version:number;seat:number;phase:string;turnSeat:number;remainingMs:number;turnDeadline:number|null;offlineDeadline:number|null;ownerOnline:boolean;guestOnline:boolean;loserSeat:number|null;winnerSeat:number|null;serverNow:number;expiresAt:number;accepted:boolean;rejection:string|null}
async function command(room:string,action:string,id:string|null=null,version:number|null=null){
  const r=await db.query<{reply:ProbeReply}>('SELECT public.gomoku_diag_command($1,$2,$3,$4) AS reply',[room,action,id,version]);return r.rows[0].reply;
}
describe('candidate SQL on local PostgreSQL only',()=>{
  it('preserves existing diagnostic rows while adding waiting timer defaults',async()=>{
    const row=await db.query<{guest:string;count:number;version:number;phase:string;remaining_ms:number;receipts:unknown}>(
      'SELECT guest,count,version,phase,remaining_ms,receipts FROM public.gomoku_diag_probe WHERE id=$1',[legacyRoom]);
    expect(row.rows[0]).toMatchObject({guest:'legacy-guest',count:7,version:9,phase:'waiting',remaining_ms:60000,receipts:[]});
  });
  it('allows a signed-in visitor while rejecting an unregistered anonymous identity',async()=>{
    const room=crypto.randomUUID();await user('visitor','anon');
    await expect(command(room,'join')).rejects.toThrow('unauthorized');
    await db.exec("SELECT set_config('request.jwt.claim.is_anonymous','true',false); SET ROLE anon");
    expect((await command(room,'join')).seat).toBe(1);
    expect((await command(room,'pulse',crypto.randomUUID(),0)).count).toBe(1);
  });
  it('creates two seats, denies a third and rejects missing identity',async()=>{
    const room=crypto.randomUUID();await expect(command(room,'join')).rejects.toThrow('unauthorized');
    await user('public-key-user','anon');await expect(command(room,'join')).rejects.toThrow('unauthorized');
    await user('one');expect((await command(room,'join')).seat).toBe(1);
    await user('two');expect((await command(room,'join')).seat).toBe(2);
    await user('three');await expect(command(room,'join')).rejects.toThrow('room_full');
  });
  it('persists a counter and deduplicates the original request after a fresh snapshot',async()=>{
    const room=crypto.randomUUID();await user('one');await command(room,'join');const id=crypto.randomUUID();
    expect((await command(room,'pulse',id,0)).count).toBe(1);
    expect((await command(room,'snapshot')).count).toBe(1);
    expect((await command(room,'pulse',id,0)).count).toBe(1);
    const conflict=await command(room,'pulse',crypto.randomUUID(),0);
    expect(conflict).toMatchObject({count:1,accepted:false,rejection:'state_conflict'});
    expect((await command(room,'snapshot')).count).toBe(1);
  });
  it('rejects conflicting operation IDs from another participant or version',async()=>{
    const room=crypto.randomUUID();await user('one');await command(room,'join');await user('two');await command(room,'join');
    const id=crypto.randomUUID();await command(room,'pulse',id,1);
    await expect(command(room,'pulse',id,2)).rejects.toThrow('id_conflict');
    await user('one');await expect(command(room,'pulse',id,1)).rejects.toThrow('id_conflict');
  });
  it('enforces database read isolation and rejects direct writes by browsers',async()=>{
    const room=crypto.randomUUID();await user('one');await command(room,'join');
    await db.exec('SET ROLE authenticated');expect((await db.query('SELECT id FROM public.gomoku_diag_probe')).rows).toHaveLength(1);
    await expect(db.query('UPDATE public.gomoku_diag_probe SET count=99')).rejects.toThrow('permission denied');
    await user('three');expect((await db.query('SELECT id FROM public.gomoku_diag_probe')).rows).toHaveLength(0);
    await expect(command(room,'snapshot')).rejects.toThrow('forbidden');
  });
  it('rejects expired rooms and invalid commands without changing saved state',async()=>{
    const room=crypto.randomUUID();await user('one');await command(room,'join');
    await expect(command(room,'other')).rejects.toThrow('invalid_action');
    await db.query("UPDATE public.gomoku_diag_probe SET expires_at=now()-interval '1 second'");
    await expect(command(room,'join')).rejects.toThrow('expired');
    expect((await db.query<{count:number}>('SELECT count FROM public.gomoku_diag_probe WHERE id=$1',[room])).rows[0].count).toBe(0);
  });
  it('starts a server-owned 60 second turn and gives the next seat a fresh turn after a valid pulse',async()=>{
    const room=crypto.randomUUID();await user('one');await command(room,'join');await user('two');await command(room,'join');
    const started=await command(room,'start');expect(started).toMatchObject({phase:'running',turnSeat:1,remainingMs:60000,accepted:true});
    await user('one');const current=await command(room,'snapshot');
    const moved=await command(room,'pulse',crypto.randomUUID(),current.version);
    expect(moved).toMatchObject({phase:'running',turnSeat:2,remainingMs:60000,count:1,accepted:true});
    await user('one');const wrongTurn=await command(room,'pulse',crypto.randomUUID(),moved.version);
    expect(wrongTurn).toMatchObject({phase:'running',turnSeat:2,count:1,accepted:false,rejection:'not_your_turn'});
  });
  it('adjudicates a turn timeout once and returns the same losing and winning seats',async()=>{
    const room=crypto.randomUUID();await user('one');await command(room,'join');await user('two');await command(room,'join');
    await command(room,'start');
    await db.query("UPDATE public.gomoku_diag_probe SET turn_deadline=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[room]);
    await user('two');const ended=await command(room,'snapshot');
    expect(ended).toMatchObject({phase:'timeout',turnSeat:1,remainingMs:0,loserSeat:1,winnerSeat:2});
    const again=await command(room,'snapshot');expect(again).toMatchObject({phase:'timeout',loserSeat:1,winnerSeat:2});
  });
  it('pauses at server-detected disconnect and resumes with the saved remainder after both seats reconnect',async()=>{
    const room=crypto.randomUUID();await user('one');await command(room,'join');await user('two');await command(room,'join');
    await command(room,'start');
    await db.query(`UPDATE public.gomoku_diag_probe
      SET owner_seen_at=clock_timestamp()-interval '30 seconds',guest_seen_at=clock_timestamp(),
          turn_deadline=clock_timestamp()+interval '20 seconds',remaining_ms=20000 WHERE id=$1`,[room]);
    await user('two');const paused=await command(room,'snapshot');
    expect(paused.phase).toBe('paused');expect(paused.remainingMs).toBeGreaterThan(20_000);expect(paused.remainingMs).toBeLessThan(30_000);
    await user('one');const resumed=await command(room,'snapshot');
    expect(resumed.phase).toBe('running');expect(resumed.turnSeat).toBe(1);expect(resumed.remainingMs).toBeGreaterThan(0);expect(resumed.remainingMs).toBeLessThan(30000);
  });
  it('aborts at the five minute offline deadline without assigning a winner',async()=>{
    const room=crypto.randomUUID();await user('one');await command(room,'join');await user('two');await command(room,'join');
    await command(room,'start');
    await db.query(`UPDATE public.gomoku_diag_probe SET phase='paused',remaining_ms=41000,turn_deadline=NULL,
      offline_since=clock_timestamp()-interval '5 minutes',offline_deadline=clock_timestamp()-interval '1 millisecond' WHERE id=$1`,[room]);
    await user('one');const ended=await command(room,'snapshot');
    expect(ended).toMatchObject({phase:'aborted',remainingMs:41000,loserSeat:null,winnerSeat:null});
  });
  it('settles a long-unobserved disconnect as aborted when the next request arrives',async()=>{
    const room=crypto.randomUUID();await user('one');await command(room,'join');await user('two');await command(room,'join');
    await command(room,'start');
    await db.query(`UPDATE public.gomoku_diag_probe SET owner_seen_at=clock_timestamp()-interval '400 seconds',
      guest_seen_at=clock_timestamp()-interval '400 seconds',turn_deadline=clock_timestamp()+interval '30 seconds' WHERE id=$1`,[room]);
    const ended=await command(room,'snapshot');
    expect(ended).toMatchObject({phase:'aborted',winnerSeat:null,loserSeat:null});
  });
});
