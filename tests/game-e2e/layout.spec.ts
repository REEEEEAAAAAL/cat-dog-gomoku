import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Snapshot } from '../../src/game/protocol';

const sizes = [
  { name: 'desktop', width: 1280, height: 844, mode: 'wide' },
  { name: 'large-desktop', width: 1920, height: 1080, mode: 'wide' },
  { name: 'short', width: 1024, height: 675, mode: 'wide' },
  { name: 'landscape', width: 1024, height: 768, mode: 'wide' },
  { name: 'portrait', width: 768, height: 1024, mode: 'stacked' },
  { name: 'large-portrait', width: 820, height: 1180, mode: 'stacked' },
  { name: 'small-window', width: 853, height: 563, mode: 'wide' },
];

async function fixture(page: Page) {
  const state: Snapshot = {
    pending: false, room: '11111111-1111-4111-8111-111111111111', code: 'ABCDEF1234', seat: 1,
    version: 1, gameId: '22222222-2222-4222-8222-222222222222', round: 1, phase: 'running',
    blackSeat: 1, turnSeat: 1, moves: [{ x: 7, y: 7, seat: 1, color: 1 }, { x: 8, y: 7, seat: 2, color: 2 }],
    winLine: [], winner: null, reason: null, application: null, remainingMs: 60000,
    turnDeadline: Date.now() + 60000, offlineDeadline: null, serverNow: Date.now(), expiresAt: Date.now() + 86400000,
    accepted: true, rejection: null, duplicate: false, undoRequest: null, emojis: [],
    players: [
      { name: '猫猫', animal: 'cat', ready: true, online: true, synced: true, undoLeft: 2 },
      { name: '狗狗', animal: 'dog', ready: true, online: true, synced: true, undoLeft: 2 },
    ],
  };
  await page.route(/https:\/\/.*tcloudbase/, route => route.abort());
  await page.route('**/rpc/gomoku_command', route => {
    state.version++; state.serverNow = Date.now();
    return route.fulfill({ json: state });
  });
  await page.goto('/');
  await page.locator('#create').click();
  await expect(page.locator('#gameStatus')).toHaveText('你的回合！');
  await page.evaluate(() => document.fonts.ready);
  const refresh = async () => {
    const response = page.waitForResponse(r => r.url().endsWith('/rpc/gomoku_command'));
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await response;
    await expect(page.locator('#room')).toHaveAttribute('data-phase', state.phase);
  };
  return { state, refresh };
}

async function rightGeometry(page: Page) {
  return page.evaluate(() => ['opponentPlayer', 'selfPlayer', 'undo', 'resign', 'confirm', 'cancel', 'interactionControls', 'leave'].map(id => {
    const rect = document.getElementById(id)!.getBoundingClientRect();
    return { id, x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
  }));
}

async function checkArt(page: Page) {
  const { visible, available, threshold } = await page.evaluate(() => {
    const activity = document.getElementById('asideActivity')!.getBoundingClientRect();
    const bottom = ['rematchPanel', 'applicationPanel', 'lobbyPanel', 'invitePanel'].reduce((last, id) => {
      const panel = document.getElementById(id)!;
      return panel.hidden ? last : Math.max(last, panel.getBoundingClientRect().bottom + parseFloat(getComputedStyle(panel).marginBottom));
    }, activity.top);
    return { visible: document.getElementById('room')!.dataset.art === 'true', available: activity.bottom - bottom,
      threshold: document.getElementById('board')!.getBoundingClientRect().height / 4 };
  });
  if (visible) {
    expect(available).toBeGreaterThanOrEqual(threshold);
    await expect(page.locator('#roomCompanions img')).toBeVisible();
    const art = (await page.locator('#roomCompanions').boundingBox())!;
    const controls = (await page.locator('#moveControls').boundingBox())!;
    expect(art.y + art.height).toBeLessThanOrEqual(controls.y);
    expect(Math.abs(art.x + art.width / 2 - controls.x - controls.width / 2)).toBeLessThan(1);
  } else {
    expect(available).toBeLessThan(threshold + 12);
    await expect(page.locator('#asideExtras')).toBeHidden();
    expect(await page.locator('#asideExtras').boundingBox()).toBeNull();
  }
}

async function geometry(page: Page) {
  return page.evaluate(() => ['.board-wrap', '#opponentPlayer', '#selfPlayer', '#clock'].map(selector => {
    const r = document.querySelector(selector)!.getBoundingClientRect();
    return { selector, x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  }));
}

async function coreFits(page: Page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const size = page.viewportSize()!;
  for (const rect of await geometry(page)) {
    expect(rect.x, rect.selector).toBeGreaterThanOrEqual(0);
    expect(rect.y, rect.selector).toBeGreaterThanOrEqual(0);
    expect(rect.right, rect.selector).toBeLessThanOrEqual(size.width + 1);
    expect(rect.bottom, rect.selector).toBeLessThanOrEqual(size.height + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

for (const size of sizes) {
  test(`core remains visible and stable across states at ${size.name}`, async ({ page }) => {
    test.skip(!process.env.GOMOKU_LOCAL_SQL);
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const { state, refresh } = await fixture(page);
    await expect(page.locator('#room')).toHaveAttribute('data-layout', size.mode);
    await page.mouse.move(0, 0);
    await coreFits(page);
    const baseline = await geometry(page);
    const rightBaseline = await rightGeometry(page);
    expect(baseline[0].width).toBeGreaterThanOrEqual(size.name === 'small-window' ? 440 : size.name === 'short' ? 550 : 615);
    const heading = (await page.locator('#roomHeading').boundingBox())!;
    expect(heading.y + heading.height).toBeLessThan(baseline[0].y);
    expect(Math.abs(heading.x - baseline[0].x)).toBeLessThan(1);
    expect(Math.abs(heading.x + heading.width - baseline[0].right)).toBeLessThan(1);
    await page.screenshot({ path: `test-results/responsive/${size.name}.png` });
    for (const id of ['confirm', 'undo', 'resign']) {
      expect((await page.locator(`#${id}`).boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expect(page.locator(`.action-cluster > #${id}`)).toHaveCount(1);
    }
    const confirm = (await page.locator('#confirm').boundingBox())!;
    const cancel = (await page.locator('#cancel').boundingBox())!;
    const undo = (await page.locator('#undo').boundingBox())!;
    const resign = (await page.locator('#resign').boundingBox())!;
    expect(Math.abs(confirm.y - cancel.y)).toBeLessThan(1);
    expect(Math.abs(undo.y - resign.y)).toBeLessThan(1);
    if (size.mode === 'wide') expect(undo.y + undo.height).toBeLessThan(confirm.y);
    else expect(undo.y).toBeGreaterThan(confirm.y + confirm.height);
    if (size.mode === 'stacked') {
      expect(confirm.x).toBeGreaterThan(cancel.x);
      expect(Math.abs(confirm.x - undo.x)).toBeLessThan(1);
      expect(Math.abs(cancel.x - resign.x)).toBeLessThan(1);
      expect(undo.y - confirm.y - confirm.height).toBe(16);
      expect(confirm.x - cancel.x - cancel.width).toBe(16);
      const hint = (await page.locator('#selectionHint').boundingBox())!;
      expect(Math.abs(hint.y + hint.height / 2 - confirm.y - confirm.height / 2)).toBeLessThan(1);
      expect(confirm.y - baseline[0].bottom - 5).toBe(16);
    }
    if (size.name !== 'small-window') expect(Math.max(undo.y + undo.height, confirm.y + confirm.height)).toBeLessThanOrEqual(size.height);
    if (size.mode === 'wide') {
      await expect(page.locator('#playArea > #rules')).toHaveCount(1);
      const rules = (await page.locator('#rules').boundingBox())!;
      expect(Math.abs(rules.x + rules.width - baseline[0].right)).toBeLessThan(1);
      const reactions = (await page.locator('#reactions').boundingBox())!;
      await checkArt(page);
      await expect(page.locator('#moveControls > #interactionControls')).toHaveCount(1);
      {
        expect(reactions.x).toBeGreaterThan(resign.x + resign.width);
        expect(Math.abs(reactions.y + reactions.height / 2 - resign.y - resign.height / 2)).toBeLessThanOrEqual(1);
        const picker = (await page.locator('.reaction-picker').boundingBox())!;
        const arrow = (await page.locator('#nextReactions').boundingBox())!;
        expect(Math.abs(arrow.x + arrow.width - picker.x - picker.width)).toBeLessThan(1);
        expect(Math.abs(arrow.y + arrow.height - resign.y - resign.height)).toBeLessThanOrEqual(1);
        const visibleCount = Math.round((reactions.width + 3) / 47);
        expect(Math.abs(reactions.width - (visibleCount * 47 - 3))).toBeLessThan(1);
        expect(visibleCount).toBe(Math.min(8, Math.floor((picker.width - 49) / 47)));
        if (size.name === 'desktop') expect(visibleCount).toBeGreaterThanOrEqual(5);
      }
      expect(Math.abs(confirm.y + confirm.height - baseline[0].bottom - 5)).toBeLessThan(1);
      expect(Math.abs(rules.y - baseline[0].bottom - 5 - 12)).toBeLessThan(1);
    }
    await page.locator('#rules summary').click();
    await coreFits(page);
    await page.locator('#rules summary').click();
    await page.locator('#board button').first().click();
    await expect(page.locator('#confirm')).toBeEnabled();
    await page.locator('#cancel').click();
    await page.locator('#resign').click();
    await expect(page.locator('#resignDialog')).toBeVisible();
    await page.locator('#dismissResign').click();
    state.phase = 'waiting'; state.players[1].name = ''; state.players[1].online = false;
    const moves = state.moves;
    state.moves = [];
    state.players.forEach(player => { player.ready = false; });
    await refresh(); await expect(page.locator('#gameStatus')).toHaveText('等另一个人来ing...');
    await coreFits(page);
    for (const id of ['ready', 'invite', 'copyCode']) {
      await expect(page.locator(`#${id}`)).toBeVisible();
      if (size.mode === 'wide') await expect(page.locator(`#${id}`)).toBeInViewport({ ratio: 1 });
    }
    if (size.mode === 'wide') await expect(page.locator('#lobbyTitle')).toBeHidden();
    if (size.mode === 'wide') {
      expect(await rightGeometry(page)).toEqual(rightBaseline);
      await checkArt(page);
    }
    if (size.mode === 'wide') {
      const activity = (await page.locator('#asideActivity').boundingBox())!;
      const invitation = (await page.locator('#invitePanel').boundingBox())!;
      expect(invitation.y + invitation.height).toBeLessThanOrEqual(activity.y + activity.height);
      if (size.name === 'small-window') expect(undo.y - invitation.y - invitation.height).toBeLessThanOrEqual(12);
      const spaces = await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const ready = rect('#ready'), lobby = rect('#lobbyPanel'), invite = rect('#invitePanel');
        return [ready.top - rect('#asidePlayers').bottom, lobby.bottom - 1 - ready.bottom,
          rect('#invitePanel h2').top - lobby.bottom, invite.bottom - 1 - rect('#invitePanel .copy-actions').bottom];
      });
      for (const [index, gap] of spaces.entries()) {
        const expected = size.height <= 620 && index >= 2 ? index === 2 ? 0 : 4 : 16;
        expect(Math.abs(gap - expected)).toBeLessThan(1);
      }
    }
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `test-results/responsive/${size.name}-waiting.png`, fullPage: true });
    state.phase = 'paused'; state.players[1].name = '狗狗'; state.offlineDeadline = Date.now() + 300000;
    state.moves = moves;
    await refresh(); await expect(page.locator('#gameStatus')).toHaveText('等你们重新连上');
    await coreFits(page);
    state.players[1].online = true; state.offlineDeadline = null;
    state.undoRequest = { id: 'request', seat: 2, target: 'move', removeCount: 2, restoreMs: 30000, expiresAt: Date.now() + 30000 };
    await refresh(); await expect(page.locator('#undoPanel')).toBeVisible();
    await expect(page.locator('#acceptUndo')).toBeEnabled();
    await page.locator('#acceptUndo').click({ trial: true });
    await expect(page.locator('#negotiationDialog')).toBeVisible();
    const duringUndo = await geometry(page);
    expect(Math.abs(duringUndo[0].y - baseline[0].y)).toBeLessThan(1);
    expect(Math.abs(duringUndo[1].y - baseline[1].y)).toBeLessThan(1);
    state.undoRequest = null; state.phase = 'finished'; state.reason = 'resign'; state.winner = 1;
    state.turnDeadline = null;
    await refresh(); await expect(page.locator('#resultPanel')).toBeVisible();
    await page.locator('#dismissResult').click();
    await coreFits(page);
    const collapsed = (await page.locator('#reviewGame').boundingBox())!;
    expect(collapsed.y).toBeGreaterThan(baseline[0].bottom);
    expect(Math.abs(collapsed.x + collapsed.width - baseline[0].right)).toBeLessThan(1);
    const collapsedRules = (await page.locator('#rules').boundingBox())!;
    const collapsedReplay = (await page.locator('#replayArea').boundingBox())!;
    if (size.mode === 'wide') {
      expect(await rightGeometry(page)).toEqual(rightBaseline);
      expect(collapsedRules.y - collapsedReplay.y - collapsedReplay.height).toBe(17);
      await checkArt(page);
    }
    await page.screenshot({ path: `test-results/responsive/${size.name}-finished.png`, fullPage: true });
    await page.locator('#reviewGame').click();
    await expect(page.locator('#replayTimeline')).toBeVisible();
    await coreFits(page);
    const replay = await geometry(page);
    for (let index = 0; index < 3; index++) {
      expect(replay[index]).toEqual(baseline[index]);
    }
    if (size.mode === 'wide') {
      expect(await rightGeometry(page)).toEqual(rightBaseline);
      const expandedRules = (await page.locator('#rules').boundingBox())!;
      const expandedReplay = (await page.locator('#replayArea').boundingBox())!;
      expect(expandedRules.y - collapsedRules.y).toBe(expandedReplay.height - collapsedReplay.height);
      await page.locator('#rules summary').click();
      expect(await rightGeometry(page)).toEqual(rightBaseline);
      await page.locator('#rules summary').click();
    }
    await page.screenshot({ path: `test-results/responsive/${size.name}-replay.png`, fullPage: true });
    await page.locator('#replayPrevious').click();
    await expect(page.locator('#replayCount')).toHaveText('第 1 / 2 手');
    await page.locator('#exitReplay').click();
    if (size.mode === 'wide') expect(await rightGeometry(page)).toEqual(rightBaseline);
    state.players[1].ready = true; state.players[0].ready = false;
    await refresh(); await expect(page.locator('#rematchPanel')).toBeVisible();
    if (size.mode === 'wide') {
      expect(await rightGeometry(page)).toEqual(rightBaseline);
      await checkArt(page);
    }
    expect(errors).toEqual([]);
  });
}

test('layout transitions preserve a single set of controls and narrow phone placement', async ({ page }) => {
  test.skip(!process.env.GOMOKU_LOCAL_SQL);
  await fixture(page);
  for (const size of [{ width: 390, height: 844 }, ...sizes, { width: 599, height: 844 }, { width: 600, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    const phone = size.width < 600;
    await expect(page.locator('#room')).toHaveAttribute('data-layout', phone ? 'phone' : size.width >= 960 || size.width >= 800 && size.height <= 700 ? 'wide' : 'stacked');
    for (const id of ['confirm', 'cancel', 'undo', 'resign', 'opponentPlayer', 'selfPlayer', 'replayArea']) await expect(page.locator(`#${id}`)).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (phone) {
      const [board, opponent, self] = await geometry(page);
      expect(opponent.bottom).toBeLessThan(board.y);
      expect(self.y).toBeGreaterThan(board.bottom);
      await expect(page.locator('#boardArea > #moveControls')).toHaveCount(1);
      await expect(page.locator('#mobileActions > #interactionControls')).toHaveCount(1);
    }
  }
  await page.screenshot({ path: 'test-results/responsive/phone.png', fullPage: true });
});

test('decoration uses remaining height and stays settled around the visibility threshold', async ({ page }) => {
  test.skip(!process.env.GOMOKU_LOCAL_SQL);
  await page.setViewportSize({ width: 1024, height: 460 });
  await fixture(page);
  const visibility: string[] = [];
  for (const height of [460, 500, 520, 540, 560, 600, 675, 768, 801, 844, 800, 700, 600, 560, 540, 520, 500, 460]) {
    await page.setViewportSize({ width: 1024, height });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await checkArt(page);
    await expect(page.locator('#moveControls > #interactionControls')).toHaveCount(1);
    const before = await rightGeometry(page);
    const settled = await page.evaluate(async () => {
      const room = document.getElementById('room')!;
      const values = [room.dataset.art];
      for (let frame = 0; frame < 8; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        values.push(room.dataset.art);
      }
      return values;
    });
    expect(new Set(settled).size).toBe(1);
    expect(await rightGeometry(page)).toEqual(before);
    visibility.push(settled[0]!);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(visibility).toContain('true');
  expect(visibility).toContain('false');
});
