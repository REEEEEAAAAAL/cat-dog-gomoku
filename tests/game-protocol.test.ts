import { describe, expect, it } from 'vitest';
import { isReply, rpcError, RpcError } from '../src/game/protocol';

describe('RPC error and application boundaries', () => {
  it('recognizes gateway errors without relying on localized display messages', () => {
    const error = rpcError({ message: 'ERROR: connect_required' });
    expect(error).toBeInstanceOf(RpcError); expect(error.code).toBe('connect_required');
    expect(rpcError({ message: 'forbidden' }).code).toBe('forbidden');
  });
  it('does not classify an arbitrary error containing a known word as terminal', () => {
    expect(rpcError({ message: 'temporarily_not_found_in_cache' }).code).toBe('unavailable');
    expect(rpcError({ code: 'forbidden' }).code).toBe('unavailable');
    expect(rpcError(null).code).toBe('unavailable');
  });
  it('requires an application ID and distinguishes an acknowledged withdrawal', () => {
    const pending = { pending: true, room: crypto.randomUUID(), code: '1234567890', serverNow: 123, applicationId: crypto.randomUUID() };
    expect(isReply(pending)).toBe(true);
    expect(isReply({ ...pending, applicationId: undefined })).toBe(false);
    expect(isReply({ ...pending, withdrawn: true, applicationId: null })).toBe(true);
    expect(isReply({ ...pending, withdrawn: true })).toBe(false);
  });
});
