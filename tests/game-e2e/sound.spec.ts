import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { Snapshot } from '../../src/game/protocol';
import type { GameAudio } from '../../src/game/audio';

interface Voice { kind: string; frequency: number; at: number; duration: number; stopped: boolean }
interface Probe { voices: Voice[]; contexts: AudioContext[] }
declare global { interface Window { soundProbe: Probe } }

function instrumentAudio() {
  window.soundProbe = { voices: [], contexts: [] };
  const Audio = window.AudioContext;
  const oscillator = Audio.prototype.createOscillator, buffer = Audio.prototype.createBufferSource;
  Audio.prototype.createOscillator = function () {
    if (!window.soundProbe.contexts.includes(this)) window.soundProbe.contexts.push(this);
    const source = oscillator.call(this), start = source.start.bind(source), stop = source.stop.bind(source);
    let frequency = 0, voice: Voice;
    const set = source.frequency.setValueAtTime.bind(source.frequency);
    source.frequency.setValueAtTime = (value, at) => { frequency = value; return set(value, at); };
    source.start = (at = 0) => {
      voice = { kind: source.type, frequency, at, duration: 0, stopped: false };
      window.soundProbe.voices.push(voice); start(at);
    };
    source.stop = at => { if (voice) { voice.stopped = !at; voice.duration = at ? at - voice.at : 0; } stop(at); };
    return source;
  };
  Audio.prototype.createBufferSource = function () {
    if (!window.soundProbe.contexts.includes(this)) window.soundProbe.contexts.push(this);
    const source = buffer.call(this), start = source.start.bind(source), stop = source.stop.bind(source);
    let voice: Voice;
    source.start = (at = 0) => {
      if (source.buffer && source.buffer.duration > .001) {
        voice = { kind: 'buffer', frequency: 0, at, duration: source.buffer.duration, stopped: false };
        window.soundProbe.voices.push(voice);
      }
      start(at);
    };
    source.stop = at => { if (voice) voice.stopped = !at; stop(at); };
    return source;
  };
}

async function setup(context: BrowserContext) {
  await context.route(/https:\/\//, route => route.abort('blockedbyclient'));
  await context.addInitScript(instrumentAudio);
}
async function voices(page: Page) { return page.evaluate(() => window.soundProbe.voices); }
async function count(page: Page, kind: 'move' | 'undo' | 'result' | 'animal') {
  return (await voices(page)).filter(v => kind === 'move' ? v.kind === 'buffer' && v.duration >= .2 && v.duration <= .35
    : kind === 'undo' ? v.kind === 'buffer' && v.duration >= .6 && v.duration <= .9
    : kind === 'result' ? v.kind === 'triangle' : v.kind === 'buffer' && v.duration > .9).length;
}
async function clear(page: Page) { await page.evaluate(() => { window.soundProbe.voices = []; }); }
async function poll(page: Page) {
  const response = page.waitForResponse(r => r.url().endsWith('/rpc/gomoku_command') && r.request().postDataJSON().p_action === 'snapshot');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await response;
}
async function pair(browser: Browser) {
  const contexts = await Promise.all([browser.newContext(), browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })]);
  for (const context of contexts) await setup(context);
  const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
  const errors: string[] = [];
  for (const page of [a, b]) page.on('pageerror', error => errors.push(error.message));
  await a.goto('./'); await a.locator('#cat').click();
  await expect.poll(() => count(a, 'animal')).toBe(1);
  await a.locator('#create').click();
  await expect(a.locator('#roomCode')).toHaveText(/^[A-F0-9]{10}$/);
  await b.goto(`./${new URL(a.url()).hash}`);
  await expect(b.locator('#dog')).toBeVisible();
  expect(await count(b, 'animal')).toBe(0);
  await b.locator('#dog').tap();
  await expect.poll(() => count(b, 'animal')).toBe(1);
  await b.locator('#join').click();
  await expect(a.locator('#approve')).toBeVisible(); await a.locator('#approve').click();
  await expect(b.locator('#ready')).toBeEnabled(); await a.locator('#ready').click(); await b.locator('#ready').click();
  await expect(a.locator('#ready')).toBeHidden(); await expect(b.locator('#ready')).toBeHidden();
  const black = await a.locator('#selfPlayer .color-dot').getAttribute('class');
  await clear(a); await clear(b);
  return { a, b, black: black!.includes('white') ? b : a, white: black!.includes('white') ? a : b, contexts, errors };
}
async function play(page: Page, x: number, y: number) {
  await expect(page.locator(`#board [data-x="${x}"][data-y="${y}"]`)).toHaveAttribute('aria-disabled', 'false');
  await page.locator(`#board [data-x="${x}"][data-y="${y}"]`).click();
  const response = page.waitForResponse(r => r.url().endsWith('/rpc/gomoku_command') && r.request().postDataJSON().p_action === 'move');
  await page.locator('#confirm').click();
  const snapshot = await (await response).json() as Snapshot;
  expect(snapshot.accepted).toBe(true);
  return snapshot;
}
test.beforeEach(() => { test.skip(!process.env.GOMOKU_LOCAL_SQL, 'Sound flows use isolated local PostgreSQL only'); });

test('missing move recording does not suppress the result melody', async ({ context, page }) => {
  await setup(context);
  await page.route('**/sounds/move.mp3', route => route.fulfill({ status: 404 }));
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await page.evaluate(async () => {
    const main = document.querySelector<HTMLScriptElement>('script[type="module"][src*="main.ts"]')!;
    const { GameAudio: Audio } = await import(new URL('./audio.ts', main.src).href) as { GameAudio: typeof GameAudio };
    const audio = new Audio();
    document.querySelector<HTMLButtonElement>('#cat')!.onclick = () => { audio.unlock(); audio.play(['move', 'win']); };
  });
  await page.locator('#cat').click();
  await expect.poll(() => count(page, 'result')).toBe(4);
  expect(await count(page, 'move')).toBe(0);
  expect(errors).toEqual([]);
});

test('sound identities, mute persistence, header geometry and optional audio failures', async ({ browser }) => {
  const context = await browser.newContext(); await setup(context);
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('./'); expect(await voices(page)).toEqual([]);
    for (const width of [320, 360, 390, 430, 900, 1024, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      const button = await page.locator('#sound').boundingBox(), header = await page.locator('.masthead').boundingBox();
      expect(button!.width).toBe(44); expect(button!.height).toBe(44);
      expect(Math.abs(button!.x + button!.width - header!.x - header!.width)).toBeLessThan(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.locator('#cat').click(); await expect.poll(() => count(page, 'animal')).toBe(1);
    await page.locator('#dog').click(); await expect.poll(() => count(page, 'animal')).toBe(2);
    await page.locator('#sound').click(); await expect(page.locator('#sound')).toHaveAttribute('aria-pressed', 'false');
    await clear(page); await page.locator('#cat').click(); expect(await voices(page)).toEqual([]);
    await page.reload(); await expect(page.locator('#sound')).toHaveAccessibleName('开启声音');
    await page.locator('#dog').click(); expect(await voices(page)).toEqual([]);
    await page.locator('#sound').click(); await page.locator('#dog').click(); await expect.poll(() => count(page, 'animal')).toBe(1);
    await page.reload(); expect(await voices(page)).toEqual([]);
    await page.screenshot({ path: 'test-results/screenshots/sound-home-desktop.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
  for (const failure of ['unsupported', 'resume', 'fetch', 'decode'] as const) {
    const context = await browser.newContext();
    await context.route(/https:\/\//, route => route.abort('blockedbyclient'));
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    if (failure === 'unsupported') await page.addInitScript(() => { Object.defineProperty(window, 'AudioContext', { value: undefined }); });
    if (failure === 'resume') await page.addInitScript(() => {
      Object.defineProperty(AudioContext.prototype, 'state', { configurable: true, get: () => 'suspended' });
      AudioContext.prototype.resume = () => Promise.reject(new Error('NotAllowedError'));
    });
    if (failure === 'decode') await page.addInitScript(() => { AudioContext.prototype.decodeAudioData = () => Promise.reject(new Error('DecodeError')); });
    if (failure === 'fetch') await page.route('**/sounds/*.mp3', route => route.fulfill({ status: 404 }));
    try {
      await page.goto('./'); await page.locator('#dog').click(); await page.locator('#create').click();
      await expect(page.locator('#roomCode')).toHaveText(/^[A-F0-9]{10}$/); expect(errors).toEqual([]);
    } finally { await context.close(); }
  }
});

test('confirmed moves and undo sound once on both clients; refusal and restore stay silent', async ({ browser }) => {
  const game = await pair(browser), { black, white, a, b } = game;
  try {
    await black.locator('#board [data-x="7"][data-y="7"]').click();
    expect(await count(black, 'move')).toBe(0); expect(await count(white, 'move')).toBe(0);
    await black.locator('#cancel').click();
    await play(black, 7, 7);
    for (const p of [a, b]) await expect.poll(() => count(p, 'move')).toBe(1);
    await poll(a); await poll(b);
    for (const p of [a, b]) expect(await count(p, 'move')).toBe(1);
    await black.locator('#undo').click(); await black.locator('#requestUndo').click();
    await expect(white.locator('#denyUndo')).toBeVisible(); await white.locator('#denyUndo').click();
    await expect(black.locator('#undoPanel')).toBeHidden();
    for (const p of [a, b]) expect(await count(p, 'undo')).toBe(0);
    await play(white, 8, 8); await play(black, 6, 7);
    await white.locator('#undo').click(); await white.locator('#requestUndo').click();
    await expect(black.locator('#acceptUndo')).toBeVisible();
    for (const p of [a, b]) expect(await count(p, 'undo')).toBe(0);
    await black.locator('#acceptUndo').click();
    for (const p of [a, b]) await expect.poll(() => count(p, 'undo')).toBe(1);
    await poll(a); await poll(b);
    for (const p of [a, b]) expect(await count(p, 'undo')).toBe(1);
    await a.reload(); await expect(a.locator('#board .stone')).toHaveCount(1); expect(await voices(a)).toEqual([]);
    await a.locator('#sound').click(); await a.locator('#sound').click();
    await a.evaluate(() => window.dispatchEvent(new Event('offline'))); await poll(a);
    expect(await voices(a)).toEqual([]);
    await black.locator('#sound').click();
    await clear(black); await play(white, 8, 8);
    await expect(black.locator('#board .stone')).toHaveCount(2); expect(await count(black, 'move')).toBe(0);
    await play(black, 6, 7); expect(await count(black, 'move')).toBe(0);
    await black.locator('#sound').click(); await poll(black); expect(await count(black, 'move')).toBe(0);
    await black.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await play(white, 9, 8);
    await black.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(black.locator('#board .stone')).toHaveCount(4); expect(await count(black, 'move')).toBe(0);
    await play(black, 5, 7); await expect.poll(() => count(black, 'move')).toBe(1);
    await a.setViewportSize({ width: 390, height: 844 });
    await a.screenshot({ path: 'test-results/screenshots/sound-room-mobile.png', fullPage: true });
    expect(game.errors).toEqual([]);
  } finally { await Promise.all(game.contexts.map(c => c.close())); }
});

test('last confirmed move precedes four ascending or descending notes; finished refresh stays silent', async ({ browser }) => {
  const game = await pair(browser), { black, white, a, b } = game;
  try {
    for (let x = 0; x < 4; x++) { await play(black, x, 0); await play(white, x, 2); }
    for (const page of [black, white]) await expect(page.locator('#board .stone')).toHaveCount(8);
    await clear(a); await clear(b); await play(black, 4, 0);
    for (const page of [black, white]) {
      await expect(page.locator('#resultPanel')).toBeVisible(); await expect.poll(() => count(page, 'result')).toBe(4);
      expect(await count(page, 'move')).toBe(1);
      const notes = (await voices(page)).filter(v => v.kind === 'triangle');
      expect(notes.map(n => n.frequency)).toEqual(page === black ? [523.25, 659.25, 783.99, 1046.5] : [659.25, 587.33, 523.25, 392]);
      const impact = (await voices(page)).find(v => v.kind === 'buffer' && v.duration >= .2 && v.duration <= .35)!;
      expect(notes[0].at).toBeGreaterThan(impact.at + impact.duration);
      expect(notes[3].duration).toBeGreaterThan(notes[0].duration);
      await poll(page); expect(await count(page, 'result')).toBe(4);
    }
    await a.reload(); await expect(a.locator('#resultPanel')).toBeVisible(); expect(await voices(a)).toEqual([]);
    await a.locator('#dismissResult').click(); await poll(a); expect(await voices(a)).toEqual([]);
    expect(game.errors).toEqual([]);
  } finally { await Promise.all(game.contexts.map(c => c.close())); }
});

test('server turn timeout plays opposite result melodies once on both clients', async ({ browser }) => {
  const game = await pair(browser), { black, white } = game;
  try {
    for (const page of [black, white]) {
      await expect(page.locator('#resultPanel')).toBeVisible({ timeout: 75000 });
      await expect.poll(() => count(page, 'result')).toBe(4);
      expect(await count(page, 'move')).toBe(0);
      const notes = (await voices(page)).filter(v => v.kind === 'triangle').map(v => v.frequency);
      expect(notes).toEqual(page === white ? [523.25, 659.25, 783.99, 1046.5] : [659.25, 587.33, 523.25, 392]);
      await poll(page); expect(await count(page, 'result')).toBe(4);
    }
    expect(game.errors).toEqual([]);
  } finally { await Promise.all(game.contexts.map(c => c.close())); }
});
