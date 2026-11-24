import { afterEach, describe, expect, it, vi } from 'vitest';
import { invitationUrl, publicGameEntry } from '../src/game/invitation';

const roomCode = 'A1B2C3D4E5';

afterEach(() => vi.unstubAllEnvs());

describe('game invitations', () => {
  it('uses the public entry and preserves ordered duplicate and encoded query values', () => {
    vi.stubEnv('DEV', false);
    const current = new URL('https://example.test/gomoku/?tag=a&tag=b&value=%2B#previous');
    expect(invitationUrl(current, roomCode)).toBe(`${publicGameEntry}?tag=a&tag=b&value=%2B#${roomCode}`);
  });

  it('uses the configured entry for a separate production deployment', () => {
    vi.stubEnv('DEV', false);
    const current = new URL('https://example.test/gomoku/');
    const entry = 'https://game.example.test/play/';
    expect(invitationUrl(current, roomCode, entry)).toBe(`${entry}#${roomCode}`);
  });

  it('keeps development and loopback previews on the current page', () => {
    const preview = 'http://127.0.0.1:18790/gomoku/?mode=test';
    const dev = 'http://gomoku.test:5173/lobby/';
    vi.stubEnv('DEV', false);
    expect(invitationUrl(new URL(preview), roomCode)).toBe(`${preview}#${roomCode}`);
    vi.stubEnv('DEV', true);
    expect(invitationUrl(new URL(dev), roomCode)).toBe(`${dev}#${roomCode}`);
  });
});
