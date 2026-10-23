import type { Command, Reply, InvitationInfo } from '../../src/game/protocol';
import { isReply, isInvitationInfo, rpcError } from '../../src/game/protocol';

export async function login(): Promise<void> {
  if (!localStorage.getItem('gomoku.test.uid')) localStorage.setItem('gomoku.test.uid', crypto.randomUUID());
}

async function request(command: Command): Promise<unknown> {
  const response = await fetch('/rpc/gomoku_command', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-Uid': localStorage.getItem('gomoku.test.uid') || '' },
    body: JSON.stringify(command),
  });
  const body: unknown = await response.json();
  if (!response.ok) throw rpcError(body);
  return body;
}
export async function send(command: Command): Promise<Reply> {
  const body = await request(command);
  if (!isReply(body)) throw new Error('Invalid local SQL reply');
  return body;
}
export async function inspectInvitation(command: Command): Promise<InvitationInfo> {
  const body = await request(command);
  if (!isInvitationInfo(body)) throw new Error('Invalid local invitation reply');
  return body;
}
