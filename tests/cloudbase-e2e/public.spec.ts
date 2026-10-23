import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function enter(page:Page,path='.'){
  await page.goto(path);
  if(await page.title()==='风险提醒'){
    await page.getByText('确定访问',{exact:false}).click();
    await expect(page.locator('#status')).toBeVisible();
    if(path!=='/')await page.goto(path);
  }
  await expect(page.locator('#status')).not.toHaveText('等待配置和连接');
}

test('public login, older browser APIs, two-seat HTTP polling and access boundaries',async({browser})=>{
  test.skip(!process.env.CLOUDBASE_DIAGNOSTIC_URL);
  test.setTimeout(90_000);
  const contexts=await Promise.all([browser.newContext(),browser.newContext()]);
  await Promise.all(contexts.map(context=>context.addInitScript(()=>{
    Object.defineProperty(AbortSignal,'timeout',{configurable:true,value:undefined});
    Object.defineProperty(Crypto.prototype,'randomUUID',{configurable:true,value:undefined});
  })));
  const [a,b]=await Promise.all(contexts.map(c=>c.newPage()));
  const errors:string[]=[];
  let aSnapshotRequests=0;const aPendingSnapshots=new Set<object>();
  for(const p of [a,b])p.on('pageerror',e=>errors.push(e.message));
  a.on('request',r=>{
    if(r.url().includes('/rpc/gomoku_diag_command')&&r.postDataJSON()?.p_action==='snapshot'){
      aSnapshotRequests++;aPendingSnapshots.add(r);
    }
  });
  a.on('requestfinished',r=>aPendingSnapshots.delete(r));
  a.on('requestfailed',r=>aPendingSnapshots.delete(r));
  try{
    await enter(a);
    expect(await a.evaluate(()=>typeof AbortSignal.timeout)).toBe('undefined');
    expect(await a.evaluate(()=>typeof crypto.randomUUID)).toBe('undefined');
    const pending=a.waitForRequest(r=>r.url().includes('/rpc/gomoku_diag_command'));
    await a.locator('#new').click();const first=await pending;
    await expect(a.locator('#status')).toContainText('HTTP 轮询已连接');
    const body=first.postDataJSON() as {p_room:string};
    const endpoint=first.url();const headers=await first.allHeaders();
    const auth={Authorization:headers.authorization,'Content-Type':'application/json'};
    await enter(b);
    const secondPending=b.waitForRequest(r=>r.url().includes('/rpc/gomoku_diag_command'),{timeout:15_000});
    await enter(b,`?join=1#${body.p_room}`);await secondPending;
    await expect(b.locator('#status')).toContainText('HTTP 轮询已连接');
    await expect(a.locator('#send')).toBeEnabled();await expect(b.locator('#send')).toBeEnabled();
    await a.locator('#send').click();
    await expect(a.locator('#count')).toHaveText('1');await expect(a.locator('#status')).toContainText('计数已保存');
    await expect(b.locator('#count')).toHaveText('1',{timeout:10_000});await expect(b.locator('#status')).toContainText('已通过 HTTP 轮询同步');
    await b.locator('#send').click();
    await expect(b.locator('#count')).toHaveText('2');await expect(a.locator('#count')).toHaveText('2',{timeout:10_000});
    const unauth=await a.request.post(endpoint,{data:{p_room:body.p_room,p_action:'snapshot'}});expect(unauth.ok()).toBe(false);
    const write=await a.request.patch(endpoint.replace('/rpc/gomoku_diag_command','/gomoku_diag_probe'),{headers:auth,data:{count:99}});expect(write.ok()).toBe(false);
    await a.reload();await expect(a.locator('#count')).toHaveText('2');
    await expect(a.locator('#send')).toBeEnabled();
    await a.evaluate(()=>{
      Object.defineProperty(document,'hidden',{configurable:true,value:true});
      Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(()=>aPendingSnapshots.size,{timeout:3_000}).toBe(0);
    const snapshotsWhileHidden=aSnapshotRequests;await a.waitForTimeout(5_500);
    expect(aSnapshotRequests).toBe(snapshotsWhileHidden);
    const resume=a.waitForRequest(r=>r.url().includes('/rpc/gomoku_diag_command')&&r.postDataJSON()?.p_action==='snapshot');
    await a.evaluate(()=>{
      Object.defineProperty(document,'hidden',{configurable:true,value:false});
      Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await resume;
    for(const width of [320,390,430]){await a.setViewportSize({width,height:800});expect(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
    expect(errors).toEqual([]);
  }finally{await Promise.all(contexts.map(c=>c.close()));}
});
