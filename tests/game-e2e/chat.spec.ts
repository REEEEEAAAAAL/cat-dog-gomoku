import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import type { Snapshot, Command } from '../../src/game/protocol';
import type { ChatCommand } from '../../src/game/chat-protocol';

test.beforeEach(() => test.skip(!process.env.GOMOKU_LOCAL_SQL, 'Chat tests require the isolated local database'));

async function pair(browser: Browser) {
  const contexts = await Promise.all([360,390].map(width => browser.newContext({viewport:{width,height:844},hasTouch:true})));
  const [a,b] = await Promise.all(contexts.map(c=>c.newPage()));
  const errors: string[] = [];
  const state = new Map<Page,Snapshot>();
  const commands = new Map<Page,Command>();
  for (const page of [a,b]) {
    await page.route(/https:\/\/.*tcloudbase/,r=>r.abort());
    page.on('pageerror',e=>errors.push(e.message));
    page.on('response',response=>{
      if (!response.url().endsWith('/rpc/gomoku_command')) return;
      commands.set(page,response.request().postDataJSON() as Command);
      void response.json().then((s:Snapshot)=>{if (s.pending===false) state.set(page,s);}).catch(error=>{
        if (!page.isClosed()) errors.push(error instanceof Error ? error.message : 'Invalid test response');
      });
    });
  }
  await a.goto('./'); await a.locator('#create').click();
  await expect(a.locator('#chatToggle')).toBeVisible();
  await b.goto(`./${new URL(a.url()).hash}`); await b.locator('#join').click();
  await expect(b.locator('#pendingPanel')).toBeVisible(); await expect(b.locator('#chatToggle')).toBeHidden();
  await expect(a.locator('#approve')).toBeVisible(); await a.locator('#approve').click();
  await expect(b.locator('#chatToggle')).toBeVisible();
  return {a,b,contexts,state,commands,errors};
}

async function send(page:Page,text:string) {
  if (await page.locator('#chatPanel').isHidden()) {
    await page.locator(await page.locator('#negotiationChatToggle').isVisible() ? '#negotiationChatToggle' : '#chatToggle').click();
  }
  await page.locator('#chatInput').fill(text); await page.locator('#chatSend').click();
  await expect(page.locator('#chatInput')).toHaveValue('');
}

test('mobile chat displays plain text, unread state, IME safety and restored history',async({browser})=>{
  const g=await pair(browser);
  try {
    const text='<img src=x onerror=alert(1)> 你好';
    await send(g.a,text);
    await expect(g.b.locator('#chatToggle')).toHaveAttribute('aria-label','聊天，1 条未读');
    await expect(g.b.locator('#chatToggle')).toHaveCSS('background-color','rgb(217, 233, 220)');
    await g.b.locator('#chatToggle').click(); await expect(g.b.locator('#chatMessages')).toContainText(text);
    await expect(g.b.locator('#chatMessages img')).toHaveCount(0); await expect(g.b.locator('#chatToggle')).toHaveText('聊天');
    await expect(g.b.locator('#chatToggle')).not.toHaveClass(/has-unread/);
    await g.b.locator('#chatInput').fill('正在选字');
    await g.b.locator('#chatInput').dispatchEvent('compositionstart');
    await g.b.locator('#chatInput').press('Enter'); await expect(g.b.locator('#chatMessages .own')).toHaveCount(0);
    await g.b.locator('#chatInput').dispatchEvent('compositionend');
    await g.b.locator('#chatInput').fill('　 \n'); await expect(g.b.locator('#chatSend')).toBeDisabled();
    await g.b.locator('#chatInput').fill('字'.repeat(101)); await expect(g.b.locator('#chatSend')).toBeDisabled();
    await g.b.locator('#chatInput').fill('😀'.repeat(100)); await expect(g.b.locator('#chatCount')).toHaveText('100/100 字');
    const messageList=g.b.locator('#chatMessages');
    await messageList.evaluate(el=>{el.style.flex='none';el.style.height='30px';el.scrollTop=0;});
    expect(await messageList.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop)).toBeGreaterThan(32);
    await g.b.locator('#chatInput').fill('你好，收到'); await g.b.locator('#chatSend').click();
    await expect(g.a.locator('#chatMessages')).toContainText('你好，收到');
    expect(await messageList.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop)).toBeLessThan(33);
    const ownBubble=g.b.locator('#chatMessages .chat-message.own').last();
    await expect(ownBubble.locator('.chat-sent')).toHaveText('已发送');
    const ownTextLines=await ownBubble.locator('p').evaluate(p=>{
      const style=getComputedStyle(p);
      return (p.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom))/parseFloat(style.lineHeight);
    });
    expect(ownTextLines).toBeLessThanOrEqual(1.1);
    const bubbleAlignment=await ownBubble.evaluate(item=>{
      const bubble=item.querySelector('.chat-bubble-group p')!.getBoundingClientRect();
      const sent=item.querySelector('.chat-sent')!.getBoundingClientRect();
      return {bubbleLeft:bubble.left,sentRight:sent.right,bubbleBottom:bubble.bottom,sentBottom:sent.bottom};
    });
    expect(bubbleAlignment.sentRight).toBeLessThanOrEqual(bubbleAlignment.bubbleLeft);
    expect(Math.abs(bubbleAlignment.bubbleBottom-bubbleAlignment.sentBottom)).toBeLessThan(1);
    await messageList.evaluate(el=>{el.scrollTop=0;});
    await expect(g.b.locator('#chatLatest')).toBeVisible();
    await expect(g.b.locator('#chatLatest')).toHaveText('↓');
    await expect(g.b.locator('#chatLatest')).toHaveCSS('font-size','16px');
    const latestCenter=await g.b.locator('#chatLatest').evaluate(el=>{
      const button=el.getBoundingClientRect();const panel=document.getElementById('chatPanel')!.getBoundingClientRect();
      return Math.abs(button.left+button.width/2-(panel.left+panel.width/2));
    });
    expect(latestCenter).toBeLessThan(1);
    await g.b.locator('#chatLatest').click();
    expect(await messageList.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop)).toBeLessThanOrEqual(32);
    await messageList.evaluate(el=>{el.style.flex='';el.style.height='';});
    for (const page of [g.a,g.b]) {
      const size=await page.locator('#board').boundingBox();
      await expect(page.locator('#chatInput')).toHaveCSS('font-size','16px');
      await expect(page.locator('#chatToggle')).toHaveCSS('font-size',await page.locator('#confirm').evaluate(e=>getComputedStyle(e).fontSize));
      const dimensions=await page.evaluate(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth,
        panel:document.getElementById('chatPanel')!.getBoundingClientRect().toJSON(),send:document.getElementById('chatSend')!.getBoundingClientRect().toJSON()}));
      expect(dimensions.overflow).toBeLessThanOrEqual(dimensions.width);
      expect(dimensions.panel.x).toBeGreaterThanOrEqual(0); expect(dimensions.panel.right).toBeLessThanOrEqual(dimensions.width);
      expect(dimensions.send.bottom).toBeLessThanOrEqual(844);
      await page.screenshot({path:`test-results/screenshots/chat-${dimensions.width}.png`,fullPage:true});
      await page.locator('#chatClose').click(); expect((await page.locator('#board').boundingBox())?.width).toBe(size?.width);
    }
    await g.b.locator('#chatToggle').click();
    const originalScroll=await g.b.evaluate(()=>window.scrollY);
    await g.b.locator('#chatInput').click();
    await g.b.evaluate(()=>window.scrollTo(0,Math.min(300,document.documentElement.scrollHeight-innerHeight)));
    await g.b.locator('#chatClose').click();
    await expect.poll(()=>g.b.evaluate(()=>window.scrollY)).toBe(originalScroll);
    await g.b.reload(); await expect(g.b.locator('#chatToggle')).toBeVisible(); await g.b.locator('#chatToggle').click();
    await expect(g.b.locator('#chatMessages .chat-message')).toHaveCount(2);
    await g.b.setViewportSize({width:390,height:410});
    await expect.poll(()=>g.b.locator('#chatSend').evaluate(e=>e.getBoundingClientRect().bottom)).toBeLessThanOrEqual(410);
    for (const width of [768,1280]) {
      await g.b.setViewportSize({width,height:900});
      expect(await g.b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await g.b.screenshot({path:`test-results/screenshots/chat-${width}.png`,fullPage:true});
    }
    expect(g.errors).toEqual([]);
  } finally { await Promise.all(g.contexts.map(c=>c.close())); }
});

test('lost send response retries with the same ID and failed send survives refresh',async({browser})=>{
  const g=await pair(browser);
  try {
    const operations:string[]=[]; let drop=true;
    await g.a.route('**/rpc/gomoku_chat',async route=>{
      const p=route.request().postDataJSON() as ChatCommand;
      if (!p.p_operation) return route.continue();
      operations.push(p.p_operation);
      if (drop) { drop=false; await route.fetch(); await route.abort(); } else await route.continue();
    });
    await g.a.locator('#chatToggle').click(); await g.a.locator('#chatInput').fill('回应丢失也只发送一次'); await g.a.locator('#chatSend').click();
    await expect(g.a.locator('#chatStatus')).toContainText('尚未确认');
    await expect(g.a.locator('#chatAvailability')).toContainText('尚未确认');
    await expect(g.a.locator('#chatAvailability')).toBeVisible();
    await expect(g.a.locator('#chatInput')).toHaveValue('回应丢失也只发送一次'); await g.a.locator('#chatSend').click();
    await expect(g.a.locator('#chatInput')).toHaveValue(''); expect(new Set(operations).size).toBe(1);
    await expect(g.a.locator('#chatAvailability')).toContainText('仅保留最近 50 条');
    await expect(g.b.locator('#chatToggle')).toHaveAttribute('aria-label','聊天，1 条未读');
    await g.a.unroute('**/rpc/gomoku_chat');
    await g.a.route('**/rpc/gomoku_chat',route=>route.request().postDataJSON().p_operation ? route.abort() : route.continue());
    await g.a.locator('#chatInput').fill('断线待重试'); await g.a.locator('#chatSend').click();
    await expect(g.a.locator('#chatStatus')).toContainText('尚未确认');
    await g.a.reload(); await expect(g.a.locator('#chatToggle')).toBeVisible(); await g.a.locator('#chatToggle').click();
    await expect(g.a.locator('#chatInput')).toHaveValue('断线待重试');
    await g.a.unroute('**/rpc/gomoku_chat'); await g.a.locator('#chatSend').click();
    await expect(g.a.locator('#chatInput')).toHaveValue('');
    await expect(g.a.locator('#chatMessages .chat-message')).toHaveCount(2);
    expect(g.errors).toEqual([]);
  } finally { await Promise.all(g.contexts.map(c=>c.close())); }
});

test('an in-flight chat does not clear selection or block a move or undo',async({browser})=>{
  const g=await pair(browser);
  let release:()=>void=()=>{};
  try {
    await g.a.locator('#ready').click(); await g.b.locator('#ready').click();
    await expect(g.a.locator('#gameStatus')).toContainText(/的回合|你的回合/);
    await expect(g.b.locator('#gameStatus')).toContainText(/的回合|你的回合/);
    const mover=g.state.get(g.a)!.turnSeat===g.state.get(g.a)!.seat?g.a:g.b;
    const other=mover===g.a?g.b:g.a;
    const held=new Promise<void>(resolve=>{release=resolve;});
    await mover.route('**/rpc/gomoku_chat',async route=>{
      if (!route.request().postDataJSON().p_operation) return route.continue();
      const response=await route.fetch(); await held; await route.fulfill({response});
    });
    await mover.locator('[data-x="7"][data-y="7"]').click(); await expect(mover.locator('.stone.preview')).toHaveCount(1);
    await mover.locator('#chatToggle').click(); await mover.locator('#chatInput').fill('落子不等聊天'); await mover.locator('#chatSend').click();
    await expect(mover.locator('#chatSend')).toHaveText('发送中…'); await expect(mover.locator('.stone.preview')).toHaveCount(1);
    await mover.locator('#chatClose').click(); await mover.locator('#confirm').click();
    await expect(mover.locator('.stone:not(.preview)')).toHaveCount(1); release();
    await mover.locator('#undo').click(); await mover.locator('#requestUndo').click();
    await expect(other.locator('#acceptUndo')).toBeVisible();
    await other.setViewportSize({width:1280,height:844});
    await expect(other.locator('#negotiationDialog')).toBeVisible();
    await send(other,'悔棋协商时聊天'); await other.locator('#chatClose').click();
    await expect(other.locator('#acceptUndo')).toBeVisible(); await other.locator('#acceptUndo').click();
    await expect(mover.locator('.stone:not(.preview)')).toHaveCount(0);
    expect(g.errors).toEqual([]);
  } finally {release();await Promise.all(g.contexts.map(c=>c.close()));}
});

for (const width of [390,1280]) test(`new messages preserve unread state and scroll anchor with a floating button at ${width}px`,async({browser})=>{
  const g=await pair(browser);
  let release:()=>void=()=>{};
  try {
    await g.a.setViewportSize({width,height:844});
    if (width===1280) expect((await g.a.locator('#chatToggle').boundingBox())!.width).toBe(80);
    for (let i=0;i<6;i++) {
      await Promise.all([send(g.a,`猫方消息 ${i}\n这里有两行文字`),send(g.b,`狗方消息 ${i}\n这里也有两行文字`)]);
      if (i<5) await new Promise(resolve=>setTimeout(resolve,2100));
    }
    await expect(g.a.locator('#chatMessages .chat-message')).toHaveCount(12);
    await g.a.locator('#chatMessages').evaluate(el=>{el.scrollTop=0;});
    const first=await g.a.locator('.chat-message').first().getAttribute('data-seq');
    await new Promise(resolve=>setTimeout(resolve,2100)); await send(g.b,'有新消息，请保持原位置');
    await expect(g.a.locator('#chatLatest')).toHaveAttribute('aria-label','跳到最新消息，有 1 条未读');
    await expect(g.a.locator('#chatToggle')).toHaveClass(/has-unread/);
    expect(await g.a.locator('#chatMessages').evaluate(el=>el.scrollTop)).toBeLessThan(5);
    expect(await g.a.locator('.chat-message').first().getAttribute('data-seq')).toBe(first);
    const floating=await g.a.locator('#chatLatest').evaluate(button=>{
      const rect=button.getBoundingClientRect();
      const list=document.getElementById('chatMessages')!;
      const listRect=list.getBoundingClientRect();
      const outside=document.elementFromPoint(rect.left-12,rect.top+rect.height/2);
      return {position:getComputedStyle(button).position,width:rect.width,height:rect.height,
        background:getComputedStyle(button.parentElement!).backgroundColor,
        inside:rect.top>=listRect.top && rect.bottom<=listRect.bottom,
        hitsMessage:outside===list || !!outside && list.contains(outside),listHeight:list.clientHeight};
    });
    expect(floating).toMatchObject({position:'absolute',width:32,height:32,background:'rgba(0, 0, 0, 0)',inside:true,hitsMessage:true});
    await g.a.locator('#chatMessages').evaluate(el=>{el.scrollTop=el.scrollHeight-el.clientHeight-20;});
    await expect(g.a.locator('#chatToggle')).toHaveClass(/has-unread/);
    await g.a.locator('#chatMessages').evaluate(el=>{el.scrollTop=0;});
    await expect(g.a.locator('#chatLatest')).toBeVisible();
    await g.a.locator('#chatLatest').click(); await expect(g.a.locator('#chatLatest')).toBeHidden();
    await expect(g.a.locator('#chatToggle')).not.toHaveClass(/has-unread/);
    expect(await g.a.locator('#chatMessages').evaluate(el=>el.clientHeight)).toBe(floating.listHeight);
    expect(await g.a.locator('#chatMessages').evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop)).toBeLessThan(33);
    let captured:()=>void=()=>{};
    const pending=new Promise<void>(resolve=>{captured=resolve;});
    const held=new Promise<void>(resolve=>{release=resolve;});
    await g.a.route('**/rpc/*',async route=>{
      const response=await route.fetch();
      if ((await response.text()).includes('后台收到的消息仍然未读')) { captured(); await held; }
      await route.fulfill({response});
    });
    await new Promise(resolve=>setTimeout(resolve,2100)); await send(g.b,'后台收到的消息仍然未读');
    await pending;
    await g.a.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,get:()=>true}));
    release();
    await expect(g.a.locator('#chatToggle')).toHaveClass(/has-unread/);
    await g.a.evaluate(()=>{
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(g.a.locator('#chatToggle')).not.toHaveClass(/has-unread/);
  }finally{release();await g.a.unrouteAll({behavior:'wait'});await Promise.all(g.contexts.map(c=>c.close()));}
});
