import { expect, test } from '@playwright/test';

test('idle candidate stays local, explains its limits and fits phone screens',async({page,baseURL})=>{
  test.skip(!!process.env.CLOUDBASE_DIAGNOSTIC_URL);
  const external:string[]=[];const errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
    if(new URL(route.request().url()).origin!==new URL(baseURL!).origin){external.push(new URL(route.request().url()).origin);await route.abort();}
    else await route.continue();
  });
  await page.goto('/');await expect(page.locator('#status')).toContainText(/尚未配置云端环境|请新建测试或打开邀请链接加入/);
  await expect(page.getByRole('button',{name:'发送测试信号'})).toBeDisabled();
  for(const width of [320,390,430]){
    await page.setViewportSize({width,height:800});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await page.getByRole('button',{name:'连接当前测试'}).click();
  await expect(page.locator('#status')).toContainText('请先配置环境');
  expect(errors).toEqual([]);expect(external).toEqual([]);
});
