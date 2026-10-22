import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function enter(page:Page,path='/'){
  await page.goto(path);
  if(await page.title()==='风险提醒'){
    await page.getByText('确定访问',{exact:false}).click();
    await expect(page.locator('#status')).toBeVisible();
    if(path!=='/')await page.goto(path);
  }
  await expect(page.locator('#status')).not.toHaveText('等待配置和连接');
}

async function newRoom(a:Page,b:Page){
  const joined=a.waitForRequest(request=>request.url().includes('/rpc/gomoku_diag_command')
    &&request.postDataJSON()?.p_action==='join');
  await a.locator('#new').click();
  const request=await joined;
  const room=(request.postDataJSON() as {p_room:string}).p_room;
  await enter(b,`/?join=1#${room}`);
  await expect(a.locator('#startTimer')).toBeEnabled({timeout:35_000});
  await expect(b.locator('#startTimer')).toBeEnabled({timeout:35_000});
  return room;
}

test('public server timer, turn reset, disconnect pause and five minute abort',async({browser})=>{
  test.skip(!process.env.CLOUDBASE_DIAGNOSTIC_URL);
  test.setTimeout(600_000);
  const contexts=await Promise.all([browser.newContext(),browser.newContext()]);
  const [a,b]=await Promise.all(contexts.map(context=>context.newPage()));
  try{
    await enter(a);
    await newRoom(a,b);
    await a.locator('#startTimer').click();
    await expect(a.locator('#phase')).toHaveText('计时中');
    await expect(b.locator('#turn')).toHaveText('第 1 席行棋',{timeout:15_000});
    await expect(a.locator('#timer')).toHaveText(/^5[0-9]\./);
    await a.locator('#send').click();
    await expect(a.locator('#turn')).toHaveText('第 2 席行棋');
    await expect(b.locator('#turn')).toHaveText('第 2 席行棋',{timeout:15_000});
    await expect(a.locator('#send')).toBeDisabled();
    await b.locator('#send').click();
    await expect(a.locator('#turn')).toHaveText('第 1 席行棋',{timeout:15_000});
    await expect(b.locator('#turn')).toHaveText('第 1 席行棋');
    const resetSeconds=Number((await a.locator('#timer').innerText()).replace(' 秒',''));
    expect(resetSeconds).toBeGreaterThan(45);
    expect(resetSeconds).toBeLessThanOrEqual(60);
    await expect(a.locator('#phase')).toHaveText('超时结束',{timeout:75_000});
    await expect(b.locator('#phase')).toHaveText('超时结束',{timeout:15_000});
    await expect(a.locator('#gameStatus')).toHaveText('第 1 席超时判负，第 2 席获胜。');
    await expect(b.locator('#gameStatus')).toHaveText('第 1 席超时判负，第 2 席获胜。');

    await newRoom(a,b);
    await a.locator('#startTimer').click();
    await expect(a.locator('#phase')).toHaveText('计时中');
    await a.waitForTimeout(20_000);
    await a.locator('#disconnect').click();
    await expect(b.locator('#phase')).toHaveText('断线暂停',{timeout:45_000});
    const pausedSeconds=Number((await b.locator('#timer').innerText()).replace(' 秒',''));
    expect(pausedSeconds).toBeGreaterThan(0);
    expect(pausedSeconds).toBeLessThan(50);
    await a.locator('#reconnect').click();
    await expect(a.locator('#phase')).toHaveText('计时中',{timeout:15_000});
    await expect(b.locator('#phase')).toHaveText('计时中',{timeout:15_000});
    const resumedSeconds=Number((await a.locator('#timer').innerText()).replace(' 秒',''));
    expect(resumedSeconds).toBeGreaterThan(0);
    expect(resumedSeconds).toBeLessThan(50);

    await newRoom(a,b);
    await a.locator('#startTimer').click();
    await expect(a.locator('#phase')).toHaveText('计时中');
    await a.locator('#disconnect').click();
    await expect(b.locator('#phase')).toHaveText('断线暂停',{timeout:45_000});
    await expect(b.locator('#phase')).toHaveText('已中止',{timeout:330_000});
    await expect(b.locator('#gameStatus')).toHaveText('断线等待超过 5 分钟，对局已中止，不判负。');
    await a.locator('#reconnect').click();
    await expect(a.locator('#phase')).toHaveText('已中止',{timeout:15_000});
    await expect(a.locator('#gameStatus')).toHaveText('断线等待超过 5 分钟，对局已中止，不判负。');
  }finally{
    await Promise.all(contexts.map(context=>context.close()));
  }
});
