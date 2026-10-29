import type { Command, Reply, InvitationInfo } from '../../src/game/protocol';
import { isReply, isInvitationInfo, rpcError } from '../../src/game/protocol';
import { isChatSnapshot } from '../../src/game/chat-protocol';
import type { ChatCommand, ChatSnapshot } from '../../src/game/chat-protocol';
import { fetchJsonWithTimeout } from '../../diagnostics/cloudbase/http';

export async function login(): Promise<void> {
  if (!localStorage.getItem('gomoku.test.uid')) localStorage.setItem('gomoku.test.uid', crypto.randomUUID());
}

async function request(command: Command | ChatCommand, rpc = 'gomoku_command'): Promise<unknown> {
  const { response, body } = await fetchJsonWithTimeout(`/rpc/${rpc}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-Uid': localStorage.getItem('gomoku.test.uid') || '' },
    body: JSON.stringify(command),
  }, 10_000);
  if (!response.ok) throw rpcError(body);
  return body;
}
export async function sendChat(command: ChatCommand): Promise<ChatSnapshot> {
  const body = await request(command, 'gomoku_chat');
  if (!isChatSnapshot(body)) throw new Error('Invalid local chat reply');
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
