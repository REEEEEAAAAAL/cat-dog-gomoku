import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { Snapshot } from '../../src/game/protocol';
import { writeFile } from 'node:fs/promises';

test.beforeEach(async ({ context }) => {
  if (process.env.GOMOKU_LOCAL_SQL || process.env.GOMOKU_URL?.startsWith('http://127.0.0.1')) {
    await context.route(/https:\/\/.*tcloudbase/, route => route.abort('blockedbyclient'));
  }
});

async function enter(page: Page, path = './') {
  if (process.env.GOMOKU_LOCAL_SQL || process.env.GOMOKU_URL?.startsWith('http://127.0.0.1')) {
    await page.route(/https:\/\/.*tcloudbase/, route => route.abort('blockedbyclient'));
  }
  await page.goto(path);
  if (await page.title() === '风险提醒') {
    await page.getByText('确定访问', { exact: false }).click();
    await expect(page.locator('#create')).toBeVisible();
    if (path !== './') await page.goto(path);
  }
  await expect(page).toHaveTitle('猫猫与狗狗 · 五子棋');
  await expect(page.locator('#dog svg')).toBeVisible();
  await expect(page.locator('#create')).toHaveCSS('min-height', '46px');
}

async function pair(browser: Browser, mobile = false, bothDesktop = false, verifyReadiness = false) {
  const contexts = await Promise.all([browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: 844 }, hasTouch: mobile }),
    browser.newContext({ viewport: { width: bothDesktop ? 1280 : 360, height: bothDesktop ? 900 : 800 }, hasTouch: !bothDesktop })]);
  const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
  const errors: string[] = [];
  if (process.env.GOMOKU_LOCAL_SQL || process.env.GOMOKU_URL?.startsWith('http://127.0.0.1')) {
    for (const context of contexts) await context.route(/https:\/\/.*tcloudbase/, route => route.abort('blockedbyclient'));
  }
  for (const p of [a, b]) p.on('pageerror', error => errors.push(error.message));
  let state: Snapshot | null = null;
  const snapshots: Snapshot[] = [];
  a.on('response', response => {
    if (response.url().endsWith('/rpc/gomoku_command')) void response.json().then((reply: Snapshot) => {
      if (!reply.pending) { state = reply; snapshots.push(reply); }
    }).catch(error => errors.push(error instanceof Error ? error.message : 'Unable to parse game response'));
  });
  await enter(a);
  await a.locator('#create').click();
  await expect(a.locator('#roomCode')).toHaveText(/^[A-F0-9]{10}$/);
  await enter(b, `./${new URL(a.url()).hash}`);
  await b.locator('#join').click();
  await expect(b.locator('#pendingPanel')).toBeVisible();
  await expect(a.locator('#applicationPanel')).toBeVisible();
  await a.locator('#approve').click();
  await expect(b.locator('#ready')).toBeEnabled();
  await expect(a.locator('#ready')).toHaveText('准备好啦！');
  await a.locator('#ready').click();
  if (verifyReadiness) {
    await expect(b.locator('#readyNotice')).toHaveText('对方准备好了哦~');
    await expect(b.locator('#readyNotice')).toBeVisible();
    await b.reload();
    await expect(b.locator('#readyNotice')).toBeVisible();
    for (const width of [320, 390, 760, 1280, 390]) {
      await b.setViewportSize({ width, height: 844 });
      await expect(b.locator(`${width <= 760 ? '#readySlot' : '#lobbySlot'} > #lobbyPanel`)).toHaveCount(1);
      if (width <= 760) {
        const ready = await b.locator('#ready').boundingBox(), board = await b.locator('#board').boundingBox();
        expect(ready!.y + ready!.height).toBeLessThan(board!.y);
        expect(ready!.y + ready!.height).toBeLessThan(844);
      }
      expect(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await b.screenshot({ path: 'docs/internal/game-ready-mobile.png', fullPage: true });
    await a.reload();
    await expect(a.locator('#ready')).toHaveText('准备好啦！等对方');
    await expect(a.locator('#ready')).toBeDisabled();
    await expect(a.locator('#readyNotice')).toBeHidden();
  }
  await b.locator('#ready').click();
  await expect(a.locator('#gameStatus')).toContainText(/的回合|你的回合/);
  await expect(b.locator('#gameStatus')).toContainText(/的回合|你的回合/);
  return { contexts, a, b, errors, snapshots, state: () => state! };
}

test('ready notification survives refresh and mobile ready action stays above the board', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL && !process.env.GOMOKU_LOCAL_SQL);
  const game = await pair(browser, false, false, true);
  try {
    for (const page of [game.a, game.b]) {
      await expect(page.locator('#readyNotice')).toBeHidden();
      await expect(page.locator('#ready')).toBeHidden();
      await expect(page.locator('#readySlot')).toBeEmpty();
      await expect(page.locator('.turn-orbit')).toHaveCSS('background-image', /conic-gradient/);
    }
    expect(game.errors).toEqual([]);
  } finally { await finish(game.contexts); }
});

async function play(page: Page, x: number, y: number, touch = false) {
  const cell = page.locator(`#board button[data-x="${x}"][data-y="${y}"]`);
  await expect(cell).toHaveAttribute('aria-disabled', 'false');
  if (touch) await cell.tap(); else await cell.click();
  await expect(page.locator('#confirm')).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/rpc/gomoku_command') && r.request().postDataJSON()?.p_action === 'move'),
    touch ? page.locator('#confirm').tap() : page.locator('#confirm').click(),
  ]);
  const snapshot = await response.json() as Snapshot;
  expect(snapshot.accepted).toBe(true);
  return snapshot;
}

async function finish(contexts: BrowserContext[]) { await Promise.all(contexts.map(c => c.close())); }

test('home supports narrow phones and desktop without overflow', async ({ page }) => {
  await enter(page);
  for (const width of [320, 360, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await page.locator('#create').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
});

test('two players complete a real game, approve entry, recover a lost acknowledgement, rematch, refresh and reject outsiders', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL && !process.env.GOMOKU_LOCAL_SQL);
  const game = await pair(browser);
  const { a, b, contexts } = game;
  try {
    const black = game.state().blackSeat === 1 ? a : b;
    const white = black === a ? b : a;
    await b.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } }); });
    await b.locator('#invite').click(); await expect(b.locator('#copyFallback')).toBeVisible();
    expect(await b.locator('#copyFallback').inputValue()).toContain('#');
    let dropped = false;
    await black.route('**/rpc/gomoku_command', async route => {
      if (!dropped && route.request().postDataJSON()?.p_action === 'move') {
        dropped = true; const result = await route.fetch(); expect(result.ok()).toBe(true); await route.abort();
      } else await route.continue();
    });
    const cell = black.locator('#board button[data-x="0"][data-y="0"]');
    await expect(cell).toHaveAttribute('aria-disabled', 'false');
    await cell.click(); await black.locator('#confirm').click();
    await expect(black.locator('#retry')).toBeVisible();
    await black.locator('#retry').click();
    await expect(black.locator('#board .stone:not(.preview)')).toHaveCount(1);
    await black.unroute('**/rpc/gomoku_command');
    await play(white, 0, 2, white === b);
    for (let x = 1; x < 5; x++) {
      await play(black, x, 0, black === b);
      if (x < 4) await play(white, x, 2, white === b);
    }
    await expect(a.locator('#gameStatus')).toContainText('获胜');
    await expect(b.locator('#gameStatus')).toContainText('获胜');
    for (const p of [a,b]) { await expect(p.locator('#resultPanel')).toBeVisible(); await expect(p.locator('#resultTitle')).toContainText('赢啦！'); }
    await a.screenshot({ path: 'docs/internal/game-victory.png', fullPage: true });
    await a.reload(); await expect(a.locator('#resultPanel')).toBeVisible();
    expect(await a.locator('#gameStatus').textContent()).toBe(await b.locator('#gameStatus').textContent());
    await expect(a.locator('#board .stone:not(.preview)')).toHaveCount(9);
    await expect(b.locator('#board .stone:not(.preview)')).toHaveCount(9);
    const oldBlack = game.state().blackSeat;
    await a.locator('#rematch').click(); await expect(a.locator('#board .stone')).toHaveCount(9);
    await expect(b.locator('#rematchPanel')).toContainText('对方邀请你再来一局喔😊');
    await b.reload(); await expect(b.locator('#rematchPanel')).toBeVisible();
    await b.locator('#acceptRematch').click();
    await expect(a.locator('#round')).toHaveText('02'); await expect(b.locator('#round')).toHaveText('02');
    expect(game.state().blackSeat).toBe(3 - oldBlack);
    await expect(a.locator('#board .stone')).toHaveCount(0);
    const nextBlack = oldBlack === 1 ? b : a;
    await play(nextBlack, 7, 7, nextBlack === b);
    await a.reload();
    await expect(a.locator('#board .stone:not(.preview)')).toHaveCount(1);
    await expect(a.locator('#gameStatus')).toContainText(/的回合|你的回合/);
    for (const p of [a, b]) {
      await expect(p.locator('#selfPlayer')).toContainText('（你）');
      await expect(p.locator('#opponentPlayer')).toContainText('（对方）');
      const above = await p.locator('#opponentPlayer').boundingBox();
      const board = await p.locator('#board').boundingBox();
      const below = await p.locator('#selfPlayer').boundingBox();
      expect(above!.y + above!.height).toBeLessThan(board!.y);
      expect(below!.y).toBeGreaterThan(board!.y + board!.height);
    }
    for (const width of [320, 360, 390, 430, 1280]) {
      await a.setViewportSize({ width, height: 844 });
      expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const box = await a.locator('#board').boundingBox(); expect(box!.width).toBeLessThanOrEqual(600);
    }
    await a.setViewportSize({ width: 390, height: 844 });
    await a.screenshot({ path: 'docs/internal/game-mobile.png', fullPage: true });
    await a.setViewportSize({ width: 1280, height: 900 });
    await a.screenshot({ path: 'docs/internal/game-desktop.png', fullPage: true });
    const outsider = await browser.newContext(); const c = await outsider.newPage();
    try { await enter(c, `./${new URL(a.url()).hash}`); await c.locator('#join').click(); await expect(c.locator('#notice')).toContainText('已有两位'); }
    finally { await outsider.close(); }
    expect(game.errors).toEqual([]);
    await a.locator('#leave').click(); await a.locator('#confirmLeave').click();
    await expect(b.locator('#gameStatus')).toHaveText('房间已关闭');
    for (const p of [a, b]) expect(await p.evaluate(() => localStorage.getItem('gomoku.room'))).toBeNull();
    let closedRequests = 0;
    for (const p of [a, b]) p.on('request', request => { if (request.url().endsWith('/rpc/gomoku_command')) closedRequests++; });
    await a.waitForTimeout(6500); expect(closedRequests).toBe(0);
    await a.locator('#homeReturn').click(); await expect(a.locator('#create')).toBeVisible();
    await expect(a.locator('#resume')).toBeHidden();
  } finally { await finish(contexts); }
});

test('touch preview, adjustment, cancel, scroll gesture and keyboard confirmation', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL && !process.env.GOMOKU_LOCAL_SQL);
  const game = await pair(browser, true);
  const { a, b, contexts } = game;
  try {
    const p = game.state().blackSeat === 1 ? a : b;
    const cell = p.locator('#board button[data-x="7"][data-y="7"]');
    await expect(cell).toHaveAttribute('aria-disabled', 'false');
    await cell.tap(); await expect(p.locator('#board .preview')).toHaveCount(1);
    await expect(p.locator('#board .stone:not(.preview)')).toHaveCount(0);
    await p.locator('#board button[data-x="8"][data-y="7"]').tap();
    await expect(p.locator('#selectionHint')).toContainText('I8');
    await p.locator('#cancel').tap(); await expect(p.locator('#board .preview')).toHaveCount(0);
    await cell.dispatchEvent('pointerdown', { clientX: 100, clientY: 100, pointerType: 'touch' });
    await cell.dispatchEvent('pointerup', { clientX: 100, clientY: 140, pointerType: 'touch' });
    await expect(p.locator('#board .preview')).toHaveCount(0);
    await cell.dispatchEvent('pointerdown', { clientX: 100, clientY: 100, pointerType: 'touch' });
    await cell.dispatchEvent('pointercancel'); await cell.dispatchEvent('pointerup', { clientX: 100, clientY: 100, pointerType: 'touch' });
    await expect(p.locator('#board .preview')).toHaveCount(0);
    await cell.focus(); await p.keyboard.press('ArrowRight'); await p.keyboard.press('Enter');
    await expect(p.locator('#selectionHint')).toContainText('I8');
    await p.locator('#confirm').click(); await expect(p.locator('#board .stone:not(.preview)')).toHaveCount(1);
    expect(game.errors).toEqual([]);
  } finally { await finish(contexts); }
});

test('public authoritative timeout and disconnect pause/resume', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL && !process.env.GOMOKU_LOCAL_SQL);
  test.setTimeout(200000);
  const game = await pair(browser);
  const { a, b, contexts } = game;
  try {
    await a.bringToFront();
    expect(await a.evaluate(() => document.hidden)).toBe(false);
    const offlineAt = Date.now();
    await b.route('**/rpc/gomoku_command', route => route.abort('internetdisconnected'));
    await contexts[1].setOffline(true);
    await expect(a.locator('#gameStatus')).toHaveText('等你们重新连上', { timeout: 25000 });
    const detectedMs = Date.now() - offlineAt;
    expect(detectedMs).toBeLessThan(25000);
    await test.info().attach('disconnect-detection-ms', { body: String(detectedMs), contentType: 'text/plain' });
    await writeFile(test.info().outputPath('disconnect-detection-ms.txt'), String(detectedMs));
    const paused = await a.locator('#clock').textContent();
    await expect.poll(async () => a.locator('#clock').textContent(), { timeout: 3000 }).toBe(paused);
    await b.unroute('**/rpc/gomoku_command');
    await contexts[1].setOffline(false);
    await expect(a.locator('#gameStatus')).toContainText(/的回合|你的回合/, { timeout: 20000 });
    await expect(b.locator('#gameStatus')).toContainText(/的回合|你的回合/);
    await expect(a.locator('#gameStatus')).toContainText('获胜', { timeout: 70000 });
    await expect(b.locator('#gameStatus')).toContainText('获胜');
    await expect(a.locator('#lobbyText')).toContainText('超时');
    for (const p of [a,b]) { await expect(p.locator('#resultPanel')).toBeVisible(); await expect(p.locator('#resultReason')).toContainText('行棋超时'); }
    expect(await a.locator('#gameStatus').textContent()).toBe(await b.locator('#gameStatus').textContent());
    expect(game.errors).toEqual([]);
  } finally { await finish(contexts); }
});

test('mutual undo, exact impact, emoji delivery while paused and refreshed requests', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL && !process.env.GOMOKU_LOCAL_SQL);
  const game = await pair(browser);
  const { a, b, contexts } = game;
  try {
    for (const page of [a, b]) {
      await expect(page.locator('#selfPlayer')).toContainText('悔棋：剩余2次');
      await expect(page.locator('#opponentPlayer')).toContainText('悔棋：剩余2次');
    }
    await a.setViewportSize({ width: 390, height: 844 });
    await a.screenshot({ path: 'docs/internal/game-mobile.png', fullPage: true });
    await a.setViewportSize({ width: 1280, height: 900 });
    await a.screenshot({ path: 'docs/internal/game-desktop.png', fullPage: true });
    const black = game.state().blackSeat === 1 ? a : b;
    const white = black === a ? b : a;
    await play(black, 7, 7, black === b);
    await expect(black.locator('#undo')).toBeEnabled(); await black.locator('#undo').click();
    await expect(black.locator('#undoPreview')).toContainText('最近 1 颗');
    await play(white, 8, 8, white === b);
    await expect(black.locator('#board .stone:not(.preview)')).toHaveCount(2);
    await black.locator('#requestUndo').click();
    await expect(black.locator('#notice')).toContainText('状态已更新');
    await expect(black.locator('#undoPanel')).toBeHidden();
    await expect(black.locator('#undo')).toBeEnabled(); await black.locator('#undo').click();
    await expect(black.locator('#undoPreview')).toContainText('最近 2 颗');
    await black.locator('#requestUndo').click();
    await expect(white.locator('#undoPanel')).toBeVisible();
    const responsePanel = await white.locator('#undoPanel').boundingBox();
    const boardArea = await white.locator('#board').boundingBox();
    expect(responsePanel!.y + responsePanel!.height).toBeLessThan(boardArea!.y);
    await expect(white.locator('#undoImpact')).toContainText('最近 2 颗');
    await expect(white.locator('#gameStatus')).toHaveText('悔棋请求待处理');
    await white.locator('[data-emoji="heart"]').click();
    await expect(white.locator('#selfPlayer .reaction-bubble')).toHaveText('❤️');
    await expect(black.locator('#opponentPlayer .reaction-bubble')).toHaveText('❤️');
    await black.reload();
    await expect(black.locator('#undoPanel')).toBeVisible();
    await expect(black.locator('.reaction-bubble')).toHaveCount(0);
    await expect(white.locator('#acceptUndo')).toBeEnabled(); await white.locator('#acceptUndo').click();
    await expect(black.locator('#board .stone:not(.preview)')).toHaveCount(0);
    await expect(white.locator('#board .stone:not(.preview)')).toHaveCount(0);
    await expect(black.locator('#selfPlayer')).toContainText('悔棋：剩余1次');
    await expect(white.locator('#opponentPlayer')).toContainText('悔棋：剩余1次');
    await expect(black.locator('#gameStatus')).toContainText(/的回合|你的回合/);
    await expect(black.locator('#board button[data-x="6"][data-y="6"]')).toHaveAttribute('aria-disabled', 'false');
    await black.screenshot({ path: 'docs/internal/game-interactions.png', fullPage: true });
    expect(game.errors).toEqual([]);
  } finally { await finish(contexts); }
});

test('invalid rooms stop requesting and withdrawn or rejected applications stay withdrawn', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL && !process.env.GOMOKU_LOCAL_SQL);
  const contexts = await Promise.all([browser.newContext(), browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true })]);
  const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
  const errors: string[] = [];
  for (const p of [a, b]) p.on('pageerror', error => errors.push(error.message));
  try {
    await enter(b); await b.locator('#roomInput').fill(crypto.randomUUID()); await b.locator('#join').click();
    await expect(b.locator('#notice')).toContainText('没有找到房间');
    await expect(b.locator('#home')).toBeVisible();
    let requests = 0;
    b.on('request', request => { if (request.url().endsWith('/rpc/gomoku_command')) requests++; });
    await b.waitForTimeout(6500); expect(requests).toBe(0);
    await enter(a); await a.locator('#create').click();
    await expect(a.locator('#roomCode')).toHaveText(/^[A-F0-9]{10}$/);
    const code = await a.locator('#roomCode').textContent();
    await b.locator('#roomInput').fill(code!); await b.locator('#join').click();
    await expect(a.locator('#applicationPanel')).toBeVisible(); await a.locator('#reject').click();
    await expect(b.locator('#home')).toBeVisible(); await expect(b.locator('#notice')).toContainText('申请已结束');
    requests = 0; await b.waitForTimeout(6500); expect(requests).toBe(0);
    await expect(a.locator('#applicationPanel')).toBeHidden();
    await b.locator('#join').click(); await expect(a.locator('#applicationPanel')).toBeVisible();
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let fetched = () => {};
    const observed = new Promise<void>(resolve => { fetched = resolve; });
    await b.route('**/rpc/gomoku_command', async route => {
      if (route.request().postDataJSON()?.p_action === 'snapshot') {
        const response = await route.fetch(); fetched(); await held; await route.fulfill({ response });
      } else await route.continue();
    });
    await observed;
    await b.locator('#cancelApplication').click(); await expect(b.locator('#home')).toBeVisible();
    release(); await b.unrouteAll({ behavior: 'wait' });
    await expect(b.locator('#pendingPanel')).toBeHidden(); await expect(a.locator('#applicationPanel')).toBeHidden();
    requests = 0; await b.waitForTimeout(6500); expect(requests).toBe(0);
    await a.locator('#leave').click(); await a.locator('#confirmLeave').click();
    expect(errors).toEqual([]);
  } finally { await finish(contexts); }
});

test('public five-minute absence aborts without a winner and allows a mutual new round', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_LONG_TEST);
  test.setTimeout(410000);
  const game = await pair(browser);
  const { a, b, contexts } = game;
  try {
    await contexts[1].setOffline(true);
    await expect(a.locator('#gameStatus')).toHaveText('等你们重新连上', { timeout: 45000 });
    await expect(a.locator('#gameStatus')).toHaveText('本局已中止，不计输赢', { timeout: 310000 });
    await contexts[1].setOffline(false);
    await expect(b.locator('#gameStatus')).toHaveText('本局已中止，不计输赢');
    await a.locator('#rematch').click(); await b.locator('#rematch').click();
    await expect(a.locator('#round')).toHaveText('02'); await expect(b.locator('#round')).toHaveText('02');
    expect(game.errors).toEqual([]);
  } finally { await finish(contexts); }
});

test('clipboard success is explicit, restores labels and handles unavailable clipboard', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL && !process.env.GOMOKU_LOCAL_SQL);
  const {a,b,contexts} = await pair(browser);
  try {
    await a.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText: async (value: string) => { sessionStorage.setItem('copied-value',value); } } }); });
    await a.locator('#invite').click();
    await expect(a.locator('#invite')).toHaveText('复制成功！发送给对方让TA加入吧~');
    expect(await a.evaluate(() => sessionStorage.getItem('copied-value'))).toContain(await a.locator('#roomCode').textContent());
    await a.setViewportSize({width:320,height:844});
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await a.locator('#copyCode').click(); await expect(a.locator('#copyCode')).toHaveText('房间码复制成功！');
    expect(await a.evaluate(() => sessionStorage.getItem('copied-value'))).toBe(await a.locator('#roomCode').textContent());
    await expect(a.locator('#invite')).toHaveText('复制邀请链接',{timeout:6500});
    await b.evaluate(() => { Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined}); });
    await b.locator('#copyCode').click(); await expect(b.locator('#copyStatus')).toContainText('复制失败');
    expect(await b.locator('#copyFallback').inputValue()).toBe(await b.locator('#roomCode').textContent());
    await expect(b.locator('#copyCode')).toHaveText('复制房间码');
  } finally { await finish(contexts); }
});

test('mouse previews and moves only once after confirmation and server acknowledgement', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL && !process.env.GOMOKU_LOCAL_SQL);
  const game = await pair(browser, false, true); const {a,b,contexts}=game;
  try {
    const p=game.state().blackSeat===1?a:b;
    let moves=0;
    p.on('request',r=>{if(r.url().endsWith('/rpc/gomoku_command') && r.postDataJSON()?.p_action==='move') moves++;});
    const cell=p.locator('#board button[data-x="7"][data-y="7"]');
    await expect(p.locator('#selfPlayer .turn-orbit')).toBeVisible();
    await expect(p.locator('#selfPlayer .turn-orbit')).toHaveCSS('background-image', /conic-gradient/);
    const initialAngle = await p.locator('.turn-orbit').evaluate(node => getComputedStyle(node).getPropertyValue('--turn-angle'));
    await expect.poll(() => p.locator('.turn-orbit').evaluate(node => getComputedStyle(node).getPropertyValue('--turn-angle'))).not.toBe(initialAngle);
    await expect(p.locator('#opponentPlayer .turn-orbit')).toHaveCount(0);
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await expect(p.locator('.turn-orbit')).toBeHidden();
    await p.emulateMedia({ reducedMotion: 'no-preference' });
    await cell.click(); await expect(p.locator('#board .preview')).toHaveCount(1);
    await p.screenshot({ path: 'docs/internal/game-preview-orbit.png', fullPage: true });
    const controls = await p.locator('#moveControls').boundingBox(), selected = await cell.boundingBox();
    expect(Math.abs(controls!.y - selected!.y)).toBeLessThan(100);
    await p.locator('#board button[data-x="8"][data-y="7"]').click();
    await expect(p.locator('#selectionHint')).toContainText('I8'); expect(moves).toBe(0);
    let release=()=>{}; const held=new Promise<void>(resolve=>{release=resolve;});
    let observed=()=>{}; const requested=new Promise<void>(resolve=>{observed=resolve;});
    await p.route('**/rpc/gomoku_command',async route=>{
      if(route.request().postDataJSON()?.p_action==='move'){const response=await route.fetch();observed();await held;await route.fulfill({response});}
      else await route.continue();
    });
    await p.locator('#confirm').click(); await requested;
    await expect(p.locator('#confirm')).toBeDisabled();
    await expect(p.locator('#board .stone:not(.preview)')).toHaveCount(0);
    await p.locator('#confirm').dispatchEvent('click'); expect(moves).toBe(1);
    release(); await p.unrouteAll({behavior:'wait'});
    await expect(p.locator('#board .stone:not(.preview)')).toHaveCount(1);
    await expect(p.locator('#opponentPlayer .turn-orbit')).toBeVisible();
    await expect(p.locator('#selfPlayer .turn-orbit')).toHaveCount(0);
    await expect(p.locator('#confirm')).toBeDisabled();
    expect(game.errors).toEqual([]);
  } finally {await finish(contexts);}
});

test('undo refusal stays noticeable and repeated target gives feedback after refresh', async ({browser})=>{
  test.skip(!process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL && !process.env.GOMOKU_LOCAL_SQL);
  const game=await pair(browser);const {a,b,contexts}=game;
  try{
    const p=game.state().blackSeat===1?a:b, other=p===a?b:a;
    await play(p,7,7,p===b);await p.locator('#undo').click();await p.locator('#requestUndo').click();
    await expect(other.locator('#denyUndo')).toBeVisible();await other.locator('#denyUndo').click();
    await expect(other.locator('#undoPanel')).toBeHidden();
    await expect(p.locator('#feedback')).toContainText('对方残忍拒绝了你的悔棋申请😭');
    await p.waitForTimeout(5500);await expect(p.locator('#feedback')).toBeVisible();
    await p.reload();await expect(p.locator('#undo')).toBeEnabled();await p.locator('#undo').click();
    await expect(p.locator('#feedback')).toContainText('你本轮申请过但是失败了，下次再试试吧~');
    await expect(p.locator('#undoDialog')).not.toBeVisible();
    await expect(p.locator('#selfPlayer')).toContainText('剩余2次');
    expect(game.errors).toEqual([]);
  }finally{await finish(contexts);}
});

test('idle waiting pages stop polling and resume on activity', async ({page})=>{
  test.skip(!process.env.GOMOKU_LOCAL_SQL && !process.env.GOMOKU_URL?.startsWith('http://127.0.0.1'));
  await page.clock.install();await enter(page);await page.locator('#create').click();
  await expect(page.locator('#roomCode')).toHaveText(/^[A-F0-9]{10}$/);
  await page.clock.fastForward(121000);
  await expect(page.locator('#notice')).toContainText('暂歇自动同步');
  let requests=0;page.on('request',r=>{if(r.url().endsWith('/rpc/gomoku_command'))requests++;});
  await page.clock.fastForward(600000);expect(requests).toBe(0);
  await page.locator('#roomCode').click();await page.clock.fastForward(5000);
  await expect.poll(()=>requests).toBeGreaterThan(0);
  await expect(page.locator('#notice')).toContainText('连接正常');
});
