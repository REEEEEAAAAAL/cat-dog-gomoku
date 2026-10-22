import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { Snapshot } from '../../src/game/protocol';

async function enter(page: Page, path = './') {
  await page.goto(path);
  if (await page.title() === '风险提醒') {
    await page.getByText('确定访问', { exact: false }).click();
    await expect(page.locator('#create')).toBeVisible();
    if (path !== './') await page.goto(path);
  }
  await expect(page).toHaveTitle('狗狗与猫猫 · 五子棋');
  await expect(page.locator('#dog svg')).toBeVisible();
  await expect(page.locator('#create')).toHaveCSS('min-height', '46px');
}

async function pair(browser: Browser, mobile = false) {
  const contexts = await Promise.all([browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: 844 }, hasTouch: mobile }),
    browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true })]);
  const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
  const errors: string[] = [];
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
  await a.locator('#ready').click(); await b.locator('#ready').click();
  await expect(a.locator('#gameStatus')).toContainText('的回合');
  await expect(b.locator('#gameStatus')).toContainText('的回合');
  return { contexts, a, b, errors, snapshots, state: () => state! };
}

async function play(page: Page, x: number, y: number, touch = false) {
  const cell = page.locator(`#board button[data-x="${x}"][data-y="${y}"]`);
  await expect(cell).toHaveAttribute('aria-disabled', 'false');
  if (touch) { await cell.tap(); await expect(page.locator('#confirm')).toBeEnabled(); }
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/rpc/gomoku_command') && r.request().postDataJSON()?.p_action === 'move'),
    touch ? page.locator('#confirm').tap() : cell.click(),
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
  test.skip(!process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL);
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
    if (black === b) { await cell.tap(); await black.locator('#confirm').tap(); } else await cell.click();
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
    expect(await a.locator('#gameStatus').textContent()).toBe(await b.locator('#gameStatus').textContent());
    await expect(a.locator('#board .stone:not(.preview)')).toHaveCount(9);
    await expect(b.locator('#board .stone:not(.preview)')).toHaveCount(9);
    const oldBlack = game.state().blackSeat;
    await a.locator('#rematch').click(); await expect(a.locator('#board .stone')).toHaveCount(9);
    await b.locator('#rematch').click();
    await expect(a.locator('#round')).toHaveText('02'); await expect(b.locator('#round')).toHaveText('02');
    expect(game.state().blackSeat).toBe(3 - oldBlack);
    await expect(a.locator('#board .stone')).toHaveCount(0);
    const nextBlack = oldBlack === 1 ? b : a;
    await play(nextBlack, 7, 7, nextBlack === b);
    await a.reload();
    await expect(a.locator('#board .stone:not(.preview)')).toHaveCount(1);
    await expect(a.locator('#gameStatus')).toContainText('的回合');
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
  } finally { await finish(contexts); }
});

test('touch preview, adjustment, cancel, scroll gesture and keyboard confirmation', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL);
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
  test.skip(!process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL);
  test.setTimeout(200000);
  const game = await pair(browser);
  const { a, b, contexts } = game;
  try {
    await contexts[1].setOffline(true);
    await expect(a.locator('#gameStatus')).toHaveText('等你们重新连上', { timeout: 45000 });
    const paused = await a.locator('#clock').textContent();
    await expect.poll(async () => a.locator('#clock').textContent(), { timeout: 3000 }).toBe(paused);
    await contexts[1].setOffline(false);
    await expect(a.locator('#gameStatus')).toContainText('的回合', { timeout: 20000 });
    await expect(b.locator('#gameStatus')).toContainText('的回合');
    await expect(a.locator('#gameStatus')).toContainText('获胜', { timeout: 70000 });
    await expect(b.locator('#gameStatus')).toContainText('获胜');
    await expect(a.locator('#lobbyText')).toContainText('超时');
    expect(await a.locator('#gameStatus').textContent()).toBe(await b.locator('#gameStatus').textContent());
    expect(game.errors).toEqual([]);
  } finally { await finish(contexts); }
});

test('mutual undo, exact impact, emoji delivery while paused and refreshed requests', async ({ browser }) => {
  test.skip(!process.env.GOMOKU_URL && !process.env.GOMOKU_LIVE_LOCAL);
  const game = await pair(browser);
  const { a, b, contexts } = game;
  try {
    const black = game.state().blackSeat === 1 ? a : b;
    const white = black === a ? b : a;
    await play(black, 7, 7, black === b); await play(white, 8, 8, white === b);
    await expect(black.locator('#undo')).toBeEnabled(); await black.locator('#undo').click();
    await expect(black.locator('#undoPreview')).toContainText('最近 2 颗');
    await black.locator('#requestUndo').click();
    await expect(white.locator('#undoPanel')).toBeVisible();
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
    await expect(black.locator('#selfPlayer')).toContainText('悔棋 1 次');
    await expect(white.locator('#opponentPlayer')).toContainText('悔棋 1 次');
    await expect(black.locator('#gameStatus')).toContainText('的回合');
    await expect(black.locator('#board button[data-x="6"][data-y="6"]')).toHaveAttribute('aria-disabled', 'false');
    await black.screenshot({ path: 'docs/internal/game-interactions.png', fullPage: true });
    expect(game.errors).toEqual([]);
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
