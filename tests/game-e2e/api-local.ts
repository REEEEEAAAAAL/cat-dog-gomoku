import type { Command, Reply } from '../../src/game/protocol';
import { isReply, rpcError } from '../../src/game/protocol';

export async function login(): Promise<void> {
  if (!localStorage.getItem('gomoku.test.uid')) localStorage.setItem('gomoku.test.uid', crypto.randomUUID());
}

export async function send(command: Command): Promise<Reply> {
  const response = await fetch('/rpc/gomoku_command', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-Uid': localStorage.getItem('gomoku.test.uid') || '' },
    body: JSON.stringify(command),
  });
  const body: unknown = await response.json();
  if (!response.ok) throw rpcError(body);
  if (!isReply(body)) throw new Error('Invalid local SQL reply');
  return body;
}
