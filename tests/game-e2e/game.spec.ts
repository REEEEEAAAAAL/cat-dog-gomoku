import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { Snapshot } from '../../src/game/protocol';
import { writeFile } from 'node:fs/promises';


async function resizeRoom(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  const { width, height } = viewport;
  const mode = width < 600 ? 'phone' : width >= 960 || width >= 800 && height <= 700 ? 'wide' : 'stacked';
  await expect(page.locator('#room')).toHaveAttribute('data-layout', mode);
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(viewport);
}

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
  await expect(page).toHaveTitle('猫狗五子棋');
  await expect(page.locator('#introArt .avatar')).toHaveCount(2);
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
  await expect(a.locator('#invitePanel')).toBeVisible();
  if (verifyReadiness) {
    for (const width of [900, 1024, 1280]) {
      await resizeRoom(a, {width,height:1000});
      const lobby = await a.locator('#lobbyPanel').boundingBox(), title = await a.locator('#invitePanel h2').boundingBox();
      expect(title!.y - lobby!.y - lobby!.height).toBeGreaterThanOrEqual(0);
      expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await enter(b, `./${new URL(a.url()).hash}`);
  await expect(b.locator('#dog')).toBeVisible();
  await expect(b.locator('#cat')).toBeHidden();
  await expect(b.locator('#invitationRole')).toContainText('狗狗');
  const joinBox = await b.locator('#joinEntry').boundingBox(), createBox = await b.locator('#create').boundingBox();
  expect(joinBox!.y + joinBox!.height).toBeLessThanOrEqual(createBox!.y);
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
      await resizeRoom(b, { width, height: 844 });
      await expect(b.locator(`${width < 600 ? '#readySlot' : width >= 960 ? '#asideActivity' : '#lobbySlot'} > #lobbyPanel`)).toHaveCount(1);
      if (width < 600) {
        const ready = await b.locator('#ready').boundingBox(), board = await b.locator('#board').boundingBox();
        expect(ready!.y + ready!.height).toBeLessThan(board!.y);
        expect(ready!.y + ready!.height).toBeLessThan(844);
      }
      expect(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await b.screenshot({ path: 'test-results/screenshots/game-ready-mobile.png', fullPage: true });
    await a.reload();
    await expect(a.locator('#ready')).toHaveText('准备好啦！正在等待对方');
    await expect(a.locator('#ready')).toBeDisabled();
    await expect(a.locator('#readyNotice')).toBeHidden();
  }
  await b.locator('#ready').click();
  await expect(a.locator('#gameStatus')).toContainText(/的回合|你的回合/);
  await expect(b.locator('#gameStatus')).toContainText(/的回合|你的回合/);
  for (const page of [a, b]) {
    await expect(page.locator('#reactions button')).toHaveText(['😼', '🐶', '❤️', '🥺', '😭', '😤', '😂', '🎉']);
    await expect(page.locator('#reactions button').first()).toHaveAttribute('aria-label', '发送猫猫表情');
  }
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
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute('href', './favicon.svg?v=1');
  const favicon = await page.request.get(new URL((await icon.getAttribute('href'))!, page.url()).href);
  expect(favicon.ok()).toBe(true);
  expect(favicon.headers()['content-type']).toContain('image/svg+xml');
  expect(await favicon.text()).toContain('viewBox="0 0 36 36"');
  for (const width of [320, 360, 390, 430, 900, 1024, 1280]) {
    await resizeRoom(page, { width, height: 844 });
    const cat = await page.locator('#cat').boundingBox(), dog = await page.locator('#dog').boundingBox();
    expect(cat!.x).toBeLessThan(dog!.x);
    expect(await page.locator('#introArt .avatar').first().evaluate(node => node.outerHTML)).toBe(await page.locator('#cat .avatar').evaluate(node => node.outerHTML));
    expect(await page.locator('#introArt .avatar').last().evaluate(node => node.outerHTML)).toBe(await page.locator('#dog .avatar').evaluate(node => node.outerHTML));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect((await page.locator('#create').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const mark = await page.locator('.brand-mark').evaluate(node => {
      const black = getComputedStyle(node, '::before'), white = getComputedStyle(node.querySelector('span')!);
      return { blackWidth:black.width, blackHeight:black.height, whiteWidth:white.width, whiteHeight:white.height, radius:white.borderRadius };
    });
    expect(mark).toEqual({ blackWidth:'20px', blackHeight:'20px', whiteWidth:'20px', whiteHeight:'20px', radius:'50%' });
    if (width >= 900) {
      const inset = Math.max(0, (width - 1160) / 2) + 56;
      for (const selector of ['.masthead', 'main', 'footer']) {
        const box = await page.locator(selector).boundingBox();
        expect(Math.abs(box!.x - inset)).toBeLessThan(1);
        expect(Math.abs(width - box!.x - box!.width - inset)).toBeLessThan(1);
      }
      const caption = await page.locator('.intro-caption').boundingBox();
      const avatars = await page.locator('#introArt .avatar').all();
      const bounds = await Promise.all(avatars.map(avatar => avatar.boundingBox()));
      expect(caption!.y - Math.max(...bounds.map(box => box!.y + box!.height))).toBeGreaterThanOrEqual(16);
    }
  }
  await page.screenshot({path:'test-results/screenshots/invitation-home-desktop.png',fullPage:true});
});

test('invitation follows presence while links and room codes preserve assigned identities', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_LOCAL_SQL && !process.env.GOMOKU_URL?.startsWith('http://127.0.0.1'));
  const game = await pair(browser, false, true, true);
  const { a, b, contexts } = game;
  const outsider = await browser.newContext();
  await outsider.route(/https:\/\/.*tcloudbase/, route => route.abort('blockedbyclient'));
  const stranger = await outsider.newPage();
  for (const page of [a,b,stranger]) page.setDefaultTimeout(15000);
  const code = (await a.locator('#roomCode').textContent())!;
  async function layout(showInvite: boolean) {
    for (const width of [320, 390, 430, 900, 1024, 1280]) {
      await resizeRoom(a, { width, height: 1000 });
      await expect(a.locator(width >= 960 ? '#desktopActions > #moveControls' : '#boardArea > #moveControls')).toHaveCount(1);
      await expect(a.locator('#invitePanel')).toBeVisible({ visible: showInvite });
      expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const rules = await a.locator('#rules').boundingBox();
      const art = await a.locator('.room-companions').boundingBox();
      const image = await a.locator('.room-companions img').boundingBox();
      if (width <= 430) {
        expect(art!.height).toBe(140);
        expect(art!.y).toBeGreaterThanOrEqual(rules!.y + rules!.height);
        if (showInvite) {
          const invite = await a.locator('#invitePanel').boundingBox();
          expect(invite!.y).toBeGreaterThanOrEqual(art!.y + art!.height);
        }
      } else if (width >= 960) {
        const aside = await a.locator('#roomAside').boundingBox();
        expect(rules!.y).toBeGreaterThanOrEqual(aside!.y);
        if (image) {
          expect(Math.abs(image.y + image.height / 2 - art!.y - art!.height / 2)).toBeLessThan(2);
          expect(image.y).toBeGreaterThanOrEqual((await a.locator('#selfPlayer').boundingBox())!.y);
          const actions = await a.locator('#moveControls').boundingBox();
          expect(image.y + image.height).toBeLessThan(actions!.y);
        }
        const shift = await a.evaluate(() => {
          const panel = document.getElementById('invitePanel')!;
          const selectors = ['.board-wrap', '#opponentPlayer', '#selfPlayer'];
          const measure = () => selectors.map(selector => {
            const rect = document.querySelector(selector)!.getBoundingClientRect();
            return [rect.x, rect.y, rect.width, rect.height];
          });
          const hidden = panel.hidden, before = measure();
          panel.hidden = !hidden;
          const after = measure();
          panel.hidden = hidden;
          return Math.max(...before.flatMap((rect, i) => rect.map((value, j) => Math.abs(value - after[i][j]))));
        });
        expect(shift).toBeLessThan(2);
      }
    }
    await a.screenshot({ path: `test-results/screenshots/invitation-${showInvite ? 'offline' : 'online'}-desktop.png`, fullPage: true });
  }
  async function disconnect() {
    await contexts[1].setOffline(true);
    await expect(a.locator('#gameStatus')).toHaveText('等你们重新连上', { timeout: 25000 });
    await expect(a.locator('#invitePanel')).toBeVisible();
    const clock = await a.locator('#clock').textContent();
    await a.waitForResponse(response => response.url().endsWith('/rpc/gomoku_command'));
    await expect(a.locator('#clock')).toHaveText(clock!);
  }
  try {
    await expect(a.locator('#invitePanel')).toBeHidden();
    await expect(b.locator('#invitePanel')).toBeHidden();
    await play(game.state().blackSeat === 1 ? a : b, 7, 7);
    await layout(false);
    await disconnect();
    await layout(true);
    await enter(stranger, `./#${code}`);
    await expect(stranger.locator('#notice')).toContainText('房间已有两位玩家');
    await enter(stranger);
    await stranger.locator('#roomInput').fill(code); await stranger.locator('#join').click();
    await expect(stranger.locator('#notice')).toContainText('房间已有两位玩家');
    await expect(a.locator('#applicationPanel')).toBeHidden();
    await b.goto('about:blank');
    await contexts[1].setOffline(false);
    await enter(b, `./#${code}`);
    await expect(b.locator('#entryPanel')).toHaveClass(/invited/);
    await b.locator('#join').click();
    await expect(b.locator('#selfPlayer')).toContainText('狗狗');
    await expect(a.locator('#invitePanel')).toBeHidden();
    await expect(a.locator('#gameStatus')).toContainText(/的回合|你的回合/);
    await b.reload();
    await expect(b.locator('#invitePanel')).toBeHidden();
    await expect(b.locator('#board .stone:not(.preview)')).toHaveCount(1);
    await disconnect();
    await b.goto('about:blank');
    await contexts[1].setOffline(false);
    await enter(b);
    await expect(b.locator('#resume')).toBeVisible();
    await b.locator('#roomInput').fill(code); await b.locator('#join').click();
    await expect(b.locator('#selfPlayer')).toContainText('狗狗');
    await expect(b.locator('#board .stone:not(.preview)')).toHaveCount(1);
    await expect(a.locator('#invitePanel')).toBeHidden();
    await resizeRoom(a, {width:390,height:1000});
    await a.screenshot({path:'test-results/screenshots/invitation-online-mobile.png',fullPage:true});
    await a.locator('#leave').click(); await a.locator('#confirmLeave').click();
    await expect(a.locator('#gameStatus')).toHaveText('房间已关闭');
    await expect(a.locator('#invitePanel')).toBeHidden();
    await b.reload();
    await expect(b.locator('#invitePanel')).toBeHidden();
    expect(game.errors).toEqual([]);
  } finally { await outsider.close(); await finish(contexts); }
});

test('two players complete a real game, approve entry, recover a lost acknowledgement, rematch, refresh and reject outsiders', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL && !process.env.GOMOKU_LOCAL_SQL);
  const game = await pair(browser);
  const { a, b, contexts } = game;
  try {
    const black = game.state().blackSeat === 1 ? a : b;
    const white = black === a ? b : a;
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
    await a.screenshot({ path: 'test-results/screenshots/game-victory.png', fullPage: true });
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
    await expect(a.locator('#invitePanel')).toBeHidden(); await expect(b.locator('#invitePanel')).toBeHidden();
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
      if (p.viewportSize()!.width >= 960) {
        expect(above!.x).toBeGreaterThan(board!.x + board!.width);
        expect(below!.y).toBeGreaterThan(above!.y + above!.height);
      } else {
        expect(above!.y + above!.height).toBeLessThan(board!.y);
        expect(below!.y).toBeGreaterThan(board!.y + board!.height);
      }
    }
    for (const width of [320, 360, 390, 430, 1280]) {
      await resizeRoom(a, { width, height: 844 });
      expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const box = await a.locator('#board').boundingBox();
      expect(box!.width).toBeLessThanOrEqual(width >= 960 ? 620 : 600);
      if (width >= 960) {
        const player = await a.locator('#selfPlayer').boundingBox();
        expect(player!.x).toBeGreaterThan(box!.x + box!.width);
      }
    }
    await resizeRoom(a, { width: 390, height: 844 });
    await a.screenshot({ path: 'test-results/screenshots/game-mobile.png', fullPage: true });
    await resizeRoom(a, { width: 1280, height: 900 });
    await a.screenshot({ path: 'test-results/screenshots/game-desktop.png', fullPage: true });
    const outsider = await browser.newContext(); const c = await outsider.newPage();
    try { await enter(c, `./${new URL(a.url()).hash}`); await expect(c.locator('#notice')).toContainText('已有两位'); }
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
    await a.locator('#reviewGame').click();
    await expect(a.locator('#replayCount')).toHaveText('第 0 / 0 手');
    await expect(a.locator('#board .stone')).toHaveCount(0);
    await a.locator('#exitReplay').click();
    await expect(a.locator('#resultPanel')).toBeVisible();
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
    await resizeRoom(a, { width: 390, height: 844 });
    await a.screenshot({ path: 'test-results/screenshots/game-mobile.png', fullPage: true });
    await resizeRoom(a, { width: 1280, height: 900 });
    await a.screenshot({ path: 'test-results/screenshots/game-desktop.png', fullPage: true });
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
    const boardBeforeUndo = (await white.locator('#board').boundingBox())!;
    await black.locator('#requestUndo').click();
    await expect(white.locator('#undoPanel')).toBeVisible();
    const responsePanel = await white.locator('#undoPanel').boundingBox();
    const boardArea = await white.locator('#board').boundingBox();
    if (await white.locator('#room').getAttribute('data-layout') === 'wide') {
      expect(responsePanel!.x).toBeGreaterThan(boardArea!.x + boardArea!.width);
      expect(boardArea).toEqual(boardBeforeUndo);
      await expect(white.locator('#acceptUndo')).toBeInViewport({ ratio: 1 });
    } else expect(responsePanel!.y + responsePanel!.height).toBeLessThan(boardArea!.y);
    await expect(white.locator('#undoImpact')).toContainText('最近 2 颗');
    await expect(white.locator('#gameStatus')).toHaveText('悔棋请求待处理');
    await white.locator('[data-emoji="cat"]').click();
    await expect(white.locator('#selfPlayer .reaction-bubble')).toHaveText('😼');
    await expect(black.locator('#opponentPlayer .reaction-bubble')).toHaveText('😼');
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
    await black.screenshot({ path: 'test-results/screenshots/game-interactions.png', fullPage: true });
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
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  for (const context of contexts) {
    if (process.env.GOMOKU_LOCAL_SQL || process.env.GOMOKU_URL?.startsWith('http://127.0.0.1')) {
      await context.route(/https:\/\/.*tcloudbase/, route => route.abort('blockedbyclient'));
    }
  }
  const [a,b] = await Promise.all(contexts.map(context => context.newPage()));
  try {
    for (const page of [a,b]) {
      await enter(page); await page.locator('#create').click();
      await expect(page.locator('#invitePanel')).toBeVisible();
    }
    await a.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText: async (value: string) => { sessionStorage.setItem('copied-value',value); } } }); });
    await a.locator('#invite').click();
    await expect(a.locator('#invite')).toHaveText('复制成功！发送给对方让TA加入吧~');
    expect(await a.evaluate(() => sessionStorage.getItem('copied-value'))).toContain(await a.locator('#roomCode').textContent());
    await resizeRoom(a, {width:320,height:844});
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
    await cell.hover();
    expect(await cell.evaluate(node => getComputedStyle(node, '::before').borderRadius)).toBe('50%');
    await expect(p.locator('.rules-block')).toContainText('先点选预览，再确认落子');
    await expect(p.locator('.rules-block')).not.toContainText('电脑和手机都');
    await expect(p.locator('#selfPlayer .turn-orbit')).toBeVisible();
    await expect(p.locator('#selfPlayer .turn-orbit')).toHaveCSS('background-image', /conic-gradient/);
    const initialAngle = await p.locator('.turn-orbit').evaluate(node => getComputedStyle(node).getPropertyValue('--turn-angle'));
    await expect.poll(() => p.locator('.turn-orbit').evaluate(node => getComputedStyle(node).getPropertyValue('--turn-angle'))).not.toBe(initialAngle);
    await expect(p.locator('#opponentPlayer .turn-orbit')).toHaveCount(0);
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await expect(p.locator('.turn-orbit')).toBeVisible();
    await p.emulateMedia({ reducedMotion: 'no-preference' });
    await cell.click(); await expect(p.locator('#board .preview')).toHaveCount(1);
    await p.screenshot({ path: 'test-results/screenshots/game-preview-orbit.png', fullPage: true });
    for (const width of [960, 1024, 1280]) {
      await resizeRoom(p, { width, height: 900 });
      await expect(p.locator('#desktopActions > #moveControls')).toHaveCount(1);
      const grid = (await p.locator('.board-wrap').boundingBox())!;
      const confirm = (await p.locator('#confirm').boundingBox())!;
      const cancel = (await p.locator('#cancel').boundingBox())!;
      const opponent = (await p.locator('#opponentPlayer').boundingBox())!;
      const self = (await p.locator('#selfPlayer').boundingBox())!;
      const actions = (await p.locator('#interactionControls').boundingBox())!;
      const leave = (await p.locator('#leave').boundingBox())!;
      expect(opponent.x).toBeGreaterThan(grid.x + grid.width);
      expect(self.y).toBeGreaterThan(opponent.y + opponent.height);
      expect(confirm.x).toBeGreaterThan(grid.x + grid.width);
      expect(cancel.x).toBeGreaterThan(confirm.x + confirm.width);
      expect(actions.y + actions.height).toBeLessThan(confirm.y);
      expect(leave.y).toBeGreaterThan(confirm.y + confirm.height);
      expect(leave.y).toBeGreaterThan(grid.y + grid.height);
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    for (const width of [320, 360, 390, 430, 540]) {
      await resizeRoom(p, { width, height:844 });
      await expect(p.locator('#mobileActions > #interactionControls')).toHaveCount(1);
      await expect(p.locator('#roomAside > #leave')).toHaveCount(1);
      const undo = await p.locator('#undo').boundingBox();
      const reactions = await p.locator('#reactions').boundingBox();
      const frame = await p.locator('.board-wrap').boundingBox(), confirm = await p.locator('.action-cluster').boundingBox();
      const player = await p.locator('#selfPlayer').boundingBox();
      const above = confirm!.y - frame!.y - frame!.height - 5;
      const below = player!.y - confirm!.y - confirm!.height;
      expect(Math.abs(above - below)).toBeLessThan(2);
      expect(above).toBeGreaterThanOrEqual(15);
      expect((await p.locator('.action-cluster #undo').count())).toBe(1);
      expect(reactions!.y).toBeGreaterThanOrEqual(undo!.y + undo!.height + 7);
      expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 390) await p.screenshot({path:'test-results/screenshots/ui-spacing-after-mobile.png',fullPage:true});
    }
    await resizeRoom(p, { width:1280, height:900 });
    const reactions = p.locator('#reactions');
    await reactions.evaluate(node => { node.scrollLeft = 0; });
    await p.locator('#nextReactions').click();
    await expect.poll(() => reactions.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    await expect(p.locator('#reactions button').last()).toBeInViewport();
    await p.locator('#previousReactions').click();
    await expect.poll(() => reactions.evaluate(node => node.scrollLeft)).toBe(0);
    await p.screenshot({ path:'test-results/screenshots/game-desktop-actions.png', fullPage:true });
    await p.locator('#leave').click();
    await expect(p.locator('#leaveDialog')).toBeVisible();
    await p.locator('#stay').click();
    await expect(p.locator('#leaveDialog')).not.toBeVisible();
    await p.locator('#reactions button[data-emoji="heart"]').click();
    await expect(p.locator('#selfPlayer .reaction-bubble')).toHaveText('❤️');
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

test('invited visitors see only the remaining dog role and a prominent join action', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_LOCAL_SQL && !process.env.GOMOKU_URL?.startsWith('http://127.0.0.1'));
  const contexts = [await browser.newContext(), await browser.newContext({ viewport:{width:390,height:844},hasTouch:true })];
  const [a,b] = await Promise.all(contexts.map(c=>c.newPage()));
  try {
    await enter(a); await a.locator('#cat').click(); await a.locator('#create').click();
    await expect(a.locator('#roomCode')).toHaveText(/^[A-F0-9]{10}$/);
    await enter(b, `./#${await a.locator('#roomCode').textContent()}`);
    await expect(b.locator('#dog')).toBeVisible(); await expect(b.locator('#cat')).toBeHidden();
    await expect(b.locator('#nickname')).toHaveAttribute('placeholder','狗狗');
    await expect(a.locator('#applicationPanel')).toBeHidden();
    for(const width of [320,390,430,1280]){
      await resizeRoom(b, {width,height:844});
      expect(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const join=await b.locator('#joinEntry').boundingBox(),create=await b.locator('#create').boundingBox();
      expect(join!.y+join!.height).toBeLessThanOrEqual(create!.y);
    }
    await resizeRoom(b, {width:390,height:844});
    await b.screenshot({path:'test-results/screenshots/game-invitation-role.png',fullPage:true});
    await b.locator('#create').click();
    await expect(b.locator('#dog')).toBeVisible();await expect(b.locator('#cat')).toBeVisible();
    await expect(b.locator('#create')).toHaveText('创建房间');
    await enter(b, `./#${await a.locator('#roomCode').textContent()}`);
    await b.locator('#join').click();
    await expect(b.locator('#pendingPanel h2')).toHaveText('等房主确认ing...');
    await expect(b.locator('#pendingPanel p')).toHaveText('加入申请已送达！确认后就能看到棋局。再稍微等一下下哦~');
    await expect(a.locator('#applicationPanel h2')).toHaveText('有人来啦！！');
    await expect(a.locator('#applicantName')).toHaveText('狗狗想加入你的房间👀请确认是对方本人哦！');
    await a.locator('#approve').click();
    await expect(b.locator('#selfPlayer')).toContainText('狗狗');
  } finally {await finish(contexts);}
});


test('resignation confirms once, restores both results and swaps colors on rematch', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_LOCAL_SQL && !process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL);
  const game = await pair(browser);
  const {a,b,contexts} = game;
  try {
    const before = game.state();
    const loser = before.turnSeat === 1 ? a : b, winner = loser === a ? b : a;
    await loser.locator('#board button[data-x="7"][data-y="7"]').click();
    await expect(loser.locator('#confirm')).toBeEnabled();
    await loser.locator('#resign').click();
    await expect(loser.locator('#resignDialog')).toBeVisible();
    await expect(loser.locator('#dismissResign')).toBeFocused();
    await loser.locator('#dismissResign').click();
    await expect(loser.locator('#confirm')).toBeEnabled();
    await loser.locator('#resign').click(); await loser.keyboard.press('Escape');
    await expect(loser.locator('#confirm')).toBeEnabled();
    await loser.locator('#resign').click();
    const [response] = await Promise.all([
      loser.waitForResponse(r => r.url().endsWith('/rpc/gomoku_command') && r.request().postDataJSON()?.p_action === 'resign'),
      loser.locator('#confirmResign').click(),
    ]);
    const result = await response.json() as Snapshot;
    expect(result).toMatchObject({phase:'finished',reason:'resign',winner:3-result.seat,turnDeadline:null,undoRequest:null,moves:[]});
    const loserName = result.players[result.seat-1].name, winnerName = result.players[2-result.seat].name;
    for (const page of [loser,winner]) {
      await expect(page.locator('#resultTitle')).toHaveText(`${winnerName}赢啦！！`);
      await expect(page.locator('#resultReason')).toHaveText(`${loserName}已认输✋️😭✋️`);
      await expect(page.locator('#resign')).toBeDisabled();
      await expect(page.locator('#confirm')).toBeDisabled();
      await expect(page.locator('.stone.preview')).toHaveCount(0);
      await expect(page.locator('#gameStatus')).toHaveText(page === loser ? '已认输，下局再来一决高下！💪' : '对方决定投降，这局是你的啦～🎉');
      await page.reload();
      await expect(page.locator('#resultReason')).toHaveText(`${loserName}已认输✋️😭✋️`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({path:`test-results/screenshots/surrender-result-${page === a ? 'desktop' : 'mobile'}.png`,fullPage:true});
    }
    const clock = await winner.locator('#clock').textContent();
    await expect.poll(() => winner.locator('#notice').textContent()).toBe('对方决定投降，这局是你的啦～🎉');
    await expect(winner.locator('#clock')).toHaveText(clock!);
    await loser.locator('#rematch').click(); await expect(winner.locator('#acceptRematch')).toBeVisible();
    await winner.locator('#acceptRematch').click();
    for (const page of [a,b]) {
      await expect(page.locator('#round')).toHaveText('02');
      await expect(page.locator('#resign')).toBeEnabled();
      await expect(page.locator('#resultPanel')).toBeHidden();
    }
    await expect.poll(() => game.state().blackSeat).toBe(3-before.blackSeat);
    expect(game.errors).toEqual([]);
  } finally { await finish(contexts); }
});

test('resignation controls align on phones and desktops and dialogs fit narrow screens', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_LOCAL_SQL && !process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL);
  const game = await pair(browser);
  try {
    for (const width of [320,360,390,430,760,900,1024,1280]) {
      const page = game.a; await resizeRoom(page, {width,height:1000});
      await page.mouse.move(0, 0);
      const resign = (await page.locator('#resign').boundingBox())!, undo = (await page.locator('#undo').boundingBox())!;
      const cancel = (await page.locator('#cancel').boundingBox())!, confirm = (await page.locator('#confirm').boundingBox())!;
      expect(Math.abs(resign.y-undo.y)).toBeLessThan(1);
      expect(resign.width).toBeLessThan(undo.width);
      expect(resign.height).toBeGreaterThanOrEqual(44);
      await expect(page.locator('#resign')).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
      await expect(page.locator('#resign')).toHaveCSS('border-top-color','rgba(0, 0, 0, 0)');
      if (width >= 960) {
        await page.locator('#resign').hover();
        await expect(page.locator('#resign')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await page.mouse.move(0, 0);
      }
      if (width < 600 || width >= 960) {
        expect(Math.abs(resign.x-cancel.x)).toBeLessThan(1);
        expect(Math.abs(undo.x-confirm.x)).toBeLessThan(1);
      }
      if (width >= 600 && width < 960) expect(resign.x).toBeLessThan(undo.x);
      else expect(resign.x).toBeGreaterThan(undo.x);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width >= 960) {
        const strip = page.locator('#reactions');
        await strip.evaluate(node => { node.scrollLeft=0; });
        const visibleReactions = await strip.evaluate(node => {
          const bounds=node.getBoundingClientRect();
          return Array.from(node.children).map(child => child.getBoundingClientRect()).filter(r => r.right > bounds.left && r.left < bounds.right)
            .map(r => r.left >= bounds.left - 1 && r.right <= bounds.right + 1);
        });
        expect(visibleReactions.length).toBeGreaterThan(0);
        expect(visibleReactions.every(Boolean)).toBe(true);
        expect(visibleReactions.length).toBeLessThanOrEqual(8);
        const next = (await page.locator('#nextReactions').boundingBox())!;
        expect(next.x + next.width).toBeLessThan(width);
      }
      await page.locator('#resign').click();
      if (width >= 960) {
        const before = await page.locator('#confirmResign').evaluate(node => getComputedStyle(node).backgroundColor);
        await page.locator('#confirmResign').hover();
        await expect(page.locator('#confirmResign')).not.toHaveCSS('background-color', before);
      }
      const dialog = (await page.locator('#resignDialog').boundingBox())!;
      expect(dialog.x).toBeGreaterThanOrEqual(0); expect(dialog.x+dialog.width).toBeLessThanOrEqual(width);
      await page.screenshot({path:`test-results/screenshots/surrender-dialog-${width}.png`,fullPage:true});
      await page.locator('#dismissResign').click();
      if ([390,1280].includes(width)) await page.screenshot({path:`test-results/screenshots/surrender-game-${width}.png`,fullPage:true});
    }
    expect(game.errors).toEqual([]);
  } finally { await finish(game.contexts); }
});

test('resignation during undo clears the proposal and reconciles a lost response', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_LOCAL_SQL && !process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL);
  const game = await pair(browser);
  try {
    const mover = game.state().turnSeat === 1 ? game.a : game.b, other = mover === game.a ? game.b : game.a;
    await play(mover,7,7); await expect(mover.locator('#undo')).toBeEnabled();
    await mover.locator('#undo').click(); await mover.locator('#requestUndo').click();
    await expect(other.locator('#undoPanel')).toBeVisible();
    await expect(other.locator('#resign')).toBeEnabled();
    let acceptedRequests = 0;
    await other.route('**/rpc/gomoku_command', async route => {
      if (route.request().postDataJSON()?.p_action !== 'resign') return route.continue();
      const response = await route.fetch(); expect((await response.json() as Snapshot).reason).toBe('resign');
      acceptedRequests++;
      await route.abort('failed');
    });
    await other.locator('#resign').click(); await other.locator('#confirmResign').click();
    await expect.poll(() => acceptedRequests).toBe(1);
    await expect(other.locator('#resultReason')).toContainText('已认输');
    await expect(mover.locator('#resultReason')).toContainText('已认输');
    await other.unroute('**/rpc/gomoku_command');
    if (await other.locator('#retry').isVisible()) await other.locator('#retry').click();
    await expect(other.locator('#resultReason')).toContainText('已认输');
    await expect(other.locator('#retry')).toBeHidden();
    for (const page of [mover,other]) await expect(page.locator('#undoPanel')).toBeHidden();
    expect(game.errors).toEqual([]);
  } finally { await finish(game.contexts); }
});


test('simultaneous resignations converge on one authoritative result', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_LOCAL_SQL && !process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL);
  const game = await pair(browser);
  let release: () => void = () => {};
  const barrier = new Promise<void>(resolve => {release=resolve;});
  let arrivals = 0;
  try {
    for (const page of [game.a,game.b]) {
      await page.route('**/rpc/gomoku_command', async route => {
        if (route.request().postDataJSON()?.p_action === 'resign') {
          if (++arrivals === 2) release();
          await barrier;
        }
        await route.continue();
      });
      await page.locator('#resign').click();
    }
    const replies = [game.a,game.b].map(page => page.waitForResponse(r => r.url().endsWith('/rpc/gomoku_command') && r.request().postDataJSON()?.p_action === 'resign'));
    await Promise.all([game.a,game.b].map(page => page.locator('#confirmResign').click()));
    const results = await Promise.all((await Promise.all(replies)).map(async response => await response.json() as Snapshot));
    expect(results.filter(result => result.accepted)).toHaveLength(1);
    expect(new Set(results.map(result => result.version)).size).toBe(1);
    expect(new Set(results.map(result => result.winner)).size).toBe(1);
    for (const page of [game.a,game.b]) {
      await expect(page.locator('#resultReason')).toContainText('已认输');
      await expect(page.locator('#resignDialog')).not.toBeVisible();
    }
    expect(results.every(result => result.phase === 'finished' && result.reason === 'resign')).toBe(true);
    expect(game.errors).toEqual([]);
  } finally {release(); await finish(game.contexts);}
});

test('replay is local, independent, responsive and resets only when a rematch starts', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_LOCAL_SQL && !process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL);
  const game = await pair(browser);
  const { a, b } = game;
  try {
    for (const page of [a, b]) await expect(page.locator('#reviewGame')).toBeHidden();
    const widths = [320, 360, 390, 430, 760, 899, 900, 1024, 1280];
    const resize = async (width: number) => {
      await resizeRoom(a, { width, height: 1000 });
      await expect(a.locator(width >= 960 ? '#desktopActions > #moveControls' : '#boardArea > #moveControls')).toHaveCount(1);
    };
    const baseline = new Map<number, { selfGap: number; confirmGap: number }>();
    const offsets = () => a.evaluate(() => {
      const frame = document.querySelector('.board-wrap')!.getBoundingClientRect();
      return { selfGap: document.querySelector('#selfPlayer')!.getBoundingClientRect().top - frame.bottom,
        confirmGap: document.querySelector('#confirm')!.getBoundingClientRect().top - frame.bottom };
    });
    for (const width of widths) {
      await resize(width); baseline.set(width, await offsets());
    }
    const black = game.state().blackSeat === 1 ? a : b, white = black === a ? b : a;
    for (let x = 0; x < 5; x++) {
      await play(black, x, 0, black === b);
      if (x < 4) await play(white, x, 2, white === b);
    }
    await expect(a.locator('#resultPanel')).toBeVisible();
    await expect(b.locator('#resultPanel')).toBeVisible();
    for (const width of widths) {
      await resize(width);
      const ended = await offsets(), before = baseline.get(width)!;
      if (width >= 960 || width < 600) expect(Math.abs(width >= 960 ? ended.selfGap - before.selfGap : ended.confirmGap - before.confirmGap)).toBeLessThan(1);
      else expect(ended.confirmGap - before.confirmGap).toBeGreaterThan(40);
      await expect(a.locator('#replayDetails')).toBeHidden();
      await expect(a.locator('#replayTimeline')).toBeHidden();
      const entry = (await a.locator('#reviewGame').boundingBox())!;
      if (width >= 600) {
        const board = (await a.locator('.board-wrap').boundingBox())!;
        expect(entry.y).toBeGreaterThanOrEqual(board.y + board.height);
        expect(Math.abs(entry.x + entry.width - board.x - board.width)).toBeLessThan(1);
      } else {
        const confirm = (await a.locator('#confirm').boundingBox())!, cancel = (await a.locator('#cancel').boundingBox())!;
        expect(entry.x + entry.width).toBeLessThanOrEqual(Math.min(confirm.x, cancel.x));
      }
      expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if ([390, 1280].includes(width)) await a.screenshot({ path: `test-results/screenshots/replay-collapsed-${width}.png`, fullPage: true });
    }
    await a.evaluate(async () => { await document.fonts.ready; });
    await a.clock.install();
    await a.clock.pauseAt(new Date());
    await a.waitForTimeout(250);
    const requests: string[] = [];
    const rpcActions: string[] = [];
    a.on('request', request => {
      requests.push(request.url());
      if (request.url().endsWith('/rpc/gomoku_command')) rpcActions.push((request.postDataJSON() as { p_action: string }).p_action);
    });
    const original = game.state();
    const status = await a.locator('#gameStatus').textContent();
    const clock = await a.locator('#clock').textContent();
    await a.locator('#reviewGame').click();
    await expect(a.locator('#resultPanel')).toBeHidden();
    await expect(a.locator('#replayCount')).toHaveText('第 9 / 9 手');
    await expect(a.locator('#board .stone-number')).toHaveCount(9);
    for (const [index, move] of original.moves.entries()) {
      await expect(a.locator(`#board [data-x="${move.x}"][data-y="${move.y}"] .stone-number`)).toHaveText(String(index + 1));
    }
    await expect(a.locator('#toggleReplayNumbers')).toHaveText('隐藏步数');
    await expect(a.locator('#toggleReplayNumbers')).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await expect(a.locator('#toggleReplayNumbers')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await a.mouse.move(0, 0);
    const showing = await a.locator('#toggleReplayNumbers').evaluate(node => getComputedStyle(node).backgroundColor);
    await a.locator('#toggleReplayNumbers').hover();
    await expect(a.locator('#toggleReplayNumbers')).not.toHaveCSS('background-color', showing);
    await a.locator('#toggleReplayNumbers').click();
    await a.mouse.move(0, 0);
    await expect(a.locator('#toggleReplayNumbers')).not.toHaveCSS('background-color', showing);
    await expect(a.locator('#board .stone-number')).toHaveCount(0);
    await expect(a.locator('#toggleReplayNumbers')).toHaveText('显示步数');
    await expect(a.locator('#board .replay-current')).toHaveCount(1);
    await a.locator('#toggleReplayNumbers').click();
    await expect(a.locator('#board .stone-number')).toHaveCount(9);
    await expect(a.locator('#winOverlay line')).toHaveCount(1);
    await a.locator('#replayPrevious').click();
    await expect(a.locator('#replayCount')).toHaveText('第 8 / 9 手');
    await expect(a.locator('#replayMove')).toHaveText(`${original.players[original.moves[7].seat - 1].animal === 'cat' ? '猫猫' : '狗狗'} · 白棋`);
    await expect(a.locator('#winOverlay line')).toHaveCount(0);
    await expect(a.locator('#board .stone.replay-current')).toHaveCount(1);
    await a.locator('#replayStart').click();
    await expect(a.locator('#board .stone')).toHaveCount(0);
    await expect(a.locator('#replayPrevious')).toBeDisabled();
    await a.locator('#board [data-x="7"][data-y="7"]').click({ force: true });
    await a.locator('#board [data-x="7"][data-y="7"]').press('Enter');
    await a.locator('#confirm').evaluate((node: HTMLButtonElement) => node.click());
    await expect(a.locator('#board .preview')).toHaveCount(0);
    await expect(a.locator('#confirm')).toBeDisabled();
    await a.locator('#replayNext').click();
    await expect(a.locator('#board .stone.replay-current')).toHaveCount(1);
    await expect(a.locator('#replayMove')).toHaveText(`${original.players[original.moves[0].seat - 1].animal === 'cat' ? '猫猫' : '狗狗'} · 黑棋`);
    await a.locator('#replayProgress').evaluate((node: HTMLInputElement) => {
      node.value = '4'; node.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(a.locator('#replayCount')).toHaveText('第 4 / 9 手');
    await expect(a.locator('#board .stone')).toHaveCount(4);
    await expect(a.locator('#board .stone-number')).toHaveCount(4);
    await expect(a.locator('#board .replay-current .stone-number')).toHaveText('4');
    await expect(b.locator('#board .stone')).toHaveCount(9);
    await expect(b.locator('#resultPanel')).toBeVisible();
    await b.locator('#reviewGame').click(); await b.locator('#replayStart').click();
    await expect(b.locator('#replayCount')).toHaveText('第 0 / 9 手');
    await b.locator('#replayNext').click(); await b.locator('#toggleReplayNumbers').click();
    await expect(b.locator('#board .stone-number')).toHaveCount(0);
    await expect(a.locator('#board .stone-number')).toHaveCount(4);
    await b.locator('#replayStart').click();
    await expect(a.locator('#replayCount')).toHaveText('第 4 / 9 手');
    await a.locator('#replayEnd').click();
    await expect(a.locator('#winOverlay line')).toHaveCount(1);
    await expect(a.locator('#replayNext')).toBeDisabled();
    expect(requests).toEqual([]);
    expect(game.state()).toEqual(original);
    const asideGeometry = () => a.evaluate(() => {
      const top = document.querySelector('.board-wrap')!.getBoundingClientRect().top;
      return ['#opponentPlayer', '#selfPlayer'].map(selector => {
        const box = document.querySelector(selector)!.getBoundingClientRect();
        return { y: box.y - top, height: box.height };
      });
    });
    for (const width of [...widths, 1024, 900, 1280]) {
      await resize(width);
      const board = await a.locator('#board').boundingBox();
      const self = await a.locator('#selfPlayer').boundingBox();
      const controls = await a.locator('#replayArea').boundingBox();
      const toggle = (await a.locator('#toggleReplayNumbers').boundingBox())!;
      const navigation = (await a.locator('#replayPrevious').boundingBox())!;
      expect(navigation.y - toggle.y - toggle.height).toBeGreaterThanOrEqual(10);
      expect(controls!.y).toBeGreaterThan(board!.y + board!.height);
      if (width >= 960) {
        const frame = (await a.locator('.board-wrap').boundingBox())!;
        expect(Math.abs(controls!.x + controls!.width - frame.x - frame.width)).toBeLessThan(1);
      } else {
        expect(controls!.y).toBeGreaterThan(board!.y + board!.height);
        if (width < 600) expect(self!.y).toBeGreaterThanOrEqual(controls!.y + controls!.height);
        else expect(self!.y + self!.height).toBeLessThan(board!.y);
      }
      const expanded = await offsets(), before = baseline.get(width)!;
      const expandedAside = width >= 960 ? await asideGeometry() : null;
      if (width >= 960) expect(Math.abs(expanded.selfGap - before.selfGap)).toBeLessThan(1);
      else expect(expanded.confirmGap - before.confirmGap).toBeGreaterThan(50);
      expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(a.locator(width >= 960 ? '#desktopActions > #moveControls' : '#boardArea > #moveControls')).toHaveCount(1);
      await a.locator('#exitReplay').click();
      await expect(a.locator('#board .stone-number')).toHaveCount(0);
      await expect(a.locator('#board .replay-current')).toHaveCount(0);
      await expect(a.locator('#board .stone.last')).toHaveCount(1);
      const fullBoard = await a.locator('#board').boundingBox(), fullSelf = await a.locator('#selfPlayer').boundingBox();
      expect(fullBoard!.width).toBe(board!.width); expect(fullBoard!.height).toBe(board!.height);
      expect(fullSelf!.height).toBe(self!.height);
      const exited = await offsets();
      if (width >= 960 || width < 600) expect(Math.abs(width >= 960 ? exited.selfGap - before.selfGap : exited.confirmGap - before.confirmGap)).toBeLessThan(1);
      else expect(exited.confirmGap - before.confirmGap).toBeGreaterThan(40);
      if (expandedAside) {
        const collapsedAside = await asideGeometry();
        for (let index = 0; index < expandedAside.length; index++) {
          expect(Math.abs(expandedAside[index].y - collapsedAside[index].y)).toBeLessThan(1);
          expect(Math.abs(expandedAside[index].height - collapsedAside[index].height)).toBeLessThan(1);
        }
      }
      await expect(a.locator('#resultPanel')).toBeVisible();
      await a.locator('#reviewGame').click();
    }
    await a.screenshot({ path: 'test-results/screenshots/replay-desktop.png', fullPage: true });
    await resizeRoom(a, { width: 390, height: 1000 });
    await a.locator('#replayPrevious').click();
    await a.screenshot({ path: 'test-results/screenshots/replay-mobile.png', fullPage: true });
    expect(rpcActions.every(action => ['snapshot', 'sync'].includes(action))).toBe(true);
    for (const key of ['room', 'gameId', 'round', 'phase', 'blackSeat', 'turnSeat', 'moves', 'winLine', 'winner', 'reason', 'remainingMs', 'turnDeadline'] as const) {
      expect(game.state()[key]).toEqual(original[key]);
    }
    await expect(a.locator('#gameStatus')).toHaveText(status!);
    await expect(a.locator('#clock')).toHaveText(clock!);
    await a.clock.resume();
    await a.reload();
    await expect(a.locator('#board .stone')).toHaveCount(9);
    await a.locator('#dismissResult').click();
    await a.locator('#reviewGame').click(); await a.locator('#replayStart').click();
    await a.locator('#exitReplay').click();
    await expect(a.locator('#resultPanel')).toBeHidden();
    await a.locator('#rematch').click();
    await a.locator('#reviewGame').click(); await a.locator('#replayStart').click();
    await expect(b.locator('#acceptRematch')).toBeVisible();
    await expect(a.locator('#replayCount')).toHaveText('第 0 / 9 手');
    await b.locator('#acceptRematch').click();
    for (const page of [a, b]) {
      await expect(page.locator('#round')).toHaveText('02');
      await expect(page.locator('#replayArea')).toBeHidden();
      await expect(page.locator('#board .stone')).toHaveCount(0);
    }
    const nextBlack = game.state().blackSeat === 1 ? a : b;
    await play(nextBlack, 7, 7, nextBlack === b);
    expect(game.errors).toEqual([]);
  } finally { await finish(game.contexts); }
});

test('replay after undo and resignation excludes removed stones and supports an empty game', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_LOCAL_SQL && !process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL);
  const game = await pair(browser);
  const black = game.state().blackSeat === 1 ? game.a : game.b, white = black === game.a ? game.b : game.a;
  try {
    await play(black, 7, 7, black === game.b); await play(white, 8, 8, white === game.b);
    await black.locator('#undo').click(); await black.locator('#requestUndo').click();
    await expect(white.locator('#reviewGame')).toBeHidden();
    await white.locator('#acceptUndo').click();
    await expect(black.locator('#board .stone')).toHaveCount(0);
    await play(black, 6, 6, black === game.b);
    await white.locator('#resign').click(); await white.locator('#confirmResign').click();
    await black.reload();
    await black.locator('#reviewGame').click();
    await expect(black.locator('#replayCount')).toHaveText('第 1 / 1 手');
    await expect(black.locator('#board .stone-number')).toHaveText('1');
    await expect(black.locator('#board .replay-current')).toHaveCSS('outline-width', black.viewportSize()!.width >= 960 ? '4px' : '3px');
    await white.locator('#reviewGame').click();
    await expect(white.locator('#board .replay-current')).toHaveCSS('outline-width', white.viewportSize()!.width >= 960 ? '4px' : '3px');
    await white.locator('#exitReplay').click();
    await expect(black.locator('#board [data-x="7"][data-y="7"] .stone')).toHaveCount(0);
    await expect(black.locator('#board [data-x="8"][data-y="8"] .stone')).toHaveCount(0);
    await black.locator('#replayStart').click(); await black.locator('#replayEnd').click();
    await expect(black.locator('#board [data-x="6"][data-y="6"] .stone')).toHaveCount(1);
    await black.locator('#exitReplay').click();
    await expect(black.locator('#resultPanel')).toBeVisible();
    await black.locator('#rematch').click(); await white.locator('#acceptRematch').click();
    await expect(black.locator('#round')).toHaveText('02');
    await black.locator('#resign').click(); await black.locator('#confirmResign').click();
    await black.locator('#reviewGame').click();
    await expect(black.locator('#replayCount')).toHaveText('第 0 / 0 手');
    await expect(black.locator('#board .stone-number')).toHaveCount(0);
    await expect(black.locator('#replayMove')).toHaveText('本局尚未落子');
    for (const id of ['replayProgress', 'replayStart', 'replayPrevious', 'replayNext', 'replayEnd']) await expect(black.locator(`#${id}`)).toBeDisabled();
    await black.locator('#exitReplay').click();
    await expect(black.locator('#resultPanel')).toBeVisible();
    expect(game.errors).toEqual([]);
  } finally { await finish(game.contexts); }
});

test('replay numbers fit dense end snapshots on phones and desktops', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_LOCAL_SQL);
  const game = await pair(browser);
  const page = game.a;
  try {
    await page.route('**/rpc/gomoku_command', async route => {
      const response = await route.fetch();
      const snapshot = await response.json() as Snapshot;
      const moves = Array.from({ length: 225 }, (_, index) => {
        const color = index % 2 === 0 ? 1 : 2;
        return { x: index % 15, y: Math.floor(index / 15), color, seat: color === 1 ? snapshot.blackSeat : 3 - snapshot.blackSeat };
      });
      await route.fulfill({ response, json: { ...snapshot, phase: 'finished', reason: 'draw', moves, winLine: [],
        winner: null, turnDeadline: null, offlineDeadline: null, undoRequest: null } });
    });
    await page.reload(); await page.locator('#reviewGame').click();
    await page.evaluate(async () => { await document.fonts.ready; });
    await expect(page.locator('#board .stone-number')).toHaveCount(225);
    await expect(page.locator('#board .replay-current .stone-number')).toHaveText('225');
    await expect(page.locator('#board .replay-current')).toHaveCSS('outline-width', '4px');
    await expect(page.locator('#board .stone:not(.white) .stone-number').first()).toHaveCSS('color', 'rgb(255, 253, 247)');
    await expect(page.locator('#board .stone.white .stone-number').first()).toHaveCSS('color', 'rgb(38, 59, 54)');
    for (const width of [320, 360, 390, 760, 900, 1280]) {
      await resizeRoom(page, { width, height: 1000 });
      await expect(page.locator('#board .replay-current')).toHaveCSS('outline-width', width >= 960 ? '4px' : '3px');
      const metrics = await page.locator('.stone-number').evaluateAll(nodes => nodes.map(node => {
        const number = node.getBoundingClientRect(), stone = node.parentElement!.getBoundingClientRect();
        return { text: node.textContent, white: node.parentElement!.classList.contains('white'),
          fontSize: parseFloat(getComputedStyle(node).fontSize), diameter: stone.width,
          width: number.width / stone.width, height: number.height / stone.height,
          dx: Math.abs(number.x + number.width / 2 - stone.x - stone.width / 2),
          dy: Math.abs(number.y + number.height / 2 - stone.y - stone.height / 2) };
      }));
      expect(metrics.map(number => number.text)).toEqual(Array.from({ length: 225 }, (_, i) => String(i + 1)));
      expect(metrics.every(number => number.width < .93 && number.height < .65 && number.dx < .6 && number.dy < .6)).toBe(true);
      for (const digits of [1, 2, 3]) {
        const group = metrics.filter(number => number.text!.length === digits);
        const white = group.filter(number => number.white).map(number => number.fontSize);
        const black = group.filter(number => !number.white).map(number => number.fontSize);
        expect(Math.abs(Math.max(...white) - Math.max(...black))).toBeLessThan(.05);
        expect(Math.abs(Math.min(...white) - Math.min(...black))).toBeLessThan(.05);
        expect(group.every(number => Math.abs(number.fontSize / number.diameter - [0, .62, .56, .48][digits]) < .002)).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const icons = await page.locator('.replay-buttons svg').evaluateAll(nodes => nodes.map(node => {
        const svg = node.getBoundingClientRect(), button = node.parentElement!.getBoundingClientRect();
        const path = node.querySelector('path')!, length = path.getTotalLength();
        const points = Array.from({ length: 200 }, (_, i) => path.getPointAtLength(length * (i + .5) / 200));
        return { dx: Math.abs(svg.x + svg.width / 2 - button.x - button.width / 2),
          dy: Math.abs(svg.y + svg.height / 2 - button.y - button.height / 2),
          visualX: points.reduce((sum, point) => sum + point.x, 0) / points.length,
          visualY: points.reduce((sum, point) => sum + point.y, 0) / points.length };
      }));
      expect(icons.every(icon => icon.dx < .1 && icon.dy < .1 && Math.abs(icon.visualX - 12) < .25 && Math.abs(icon.visualY - 12) < .25)).toBe(true);
      if ([320, 390, 1280].includes(width)) await page.locator('#boardArea').screenshot({ path: `test-results/screenshots/replay-numbered-${width}.png` });
    }
    await page.locator('#toggleReplayNumbers').click();
    await expect(page.locator('#board .stone-number')).toHaveCount(0);
    await page.locator('#replayPrevious').click();
    await expect(page.locator('#board .stone-number')).toHaveCount(0);
    await expect(page.locator('#board .replay-current')).toHaveCount(1);
    await page.locator('#toggleReplayNumbers').click();
    await expect(page.locator('#board .replay-current .stone-number')).toHaveText('224');
    await page.locator('#replayProgress').evaluate((node: HTMLInputElement) => {
      node.value = '103'; node.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(page.locator('#board .stone-number')).toHaveCount(103);
    await expect(page.locator('#board .replay-current .stone-number')).toHaveText('103');
    await page.locator('#toggleReplayNumbers').click();
    await page.locator('#exitReplay').click();
    await expect(page.locator('#board .stone-number')).toHaveCount(0);
    await expect(page.locator('#board .stone.last')).toHaveCount(1);
    await page.locator('#reviewGame').click();
    await expect(page.locator('#toggleReplayNumbers')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#board .stone-number')).toHaveCount(225);
    expect(game.errors).toEqual([]);
  } finally { await finish(game.contexts); }
});

test('replay renders timeout, draw and disconnect end snapshots without requiring moves', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_LOCAL_SQL);
  const game = await pair(browser);
  try {
    for (const reason of ['timeout', 'draw', 'disconnect_timeout'] as const) {
      await game.a.route('**/rpc/gomoku_command', async route => {
        const response = await route.fetch();
        const snapshot = await response.json() as Snapshot;
        await route.fulfill({ response, json: { ...snapshot, phase: 'finished', reason, moves: [], winLine: [],
          winner: reason === 'timeout' ? 2 : null, turnDeadline: null, offlineDeadline: null, undoRequest: null } });
      });
      await game.a.reload();
      await game.a.locator('#reviewGame').click();
      await expect(game.a.locator('#replayCount')).toHaveText('第 0 / 0 手');
      await expect(game.a.locator('#board .stone')).toHaveCount(0);
      await game.a.locator('#exitReplay').click();
      await expect(game.a.locator('#gameStatus')).toContainText(reason === 'draw' ? '平分秋色' : reason === 'timeout' ? '获胜' : '中止');
      await game.a.unroute('**/rpc/gomoku_command');
    }
    expect(game.errors).toEqual([]);
  } finally { await finish(game.contexts); }
});
