import cloudbase from '@cloudbase/js-sdk';
import { fetchJsonWithTimeout } from '../../diagnostics/cloudbase/http';
import { isReply, isInvitationInfo, rpcError } from './protocol';
import type { Command, Reply, InvitationInfo } from './protocol';
import { isChatSnapshot } from './chat-protocol';
import type { ChatCommand, ChatSnapshot } from './chat-protocol';

const env = import.meta.env.VITE_CLOUDBASE_ENV_ID as string | undefined;
const accessKey = import.meta.env.VITE_CLOUDBASE_PUBLISHABLE_KEY as string | undefined;
const app = env && accessKey ? cloudbase.init({ env, accessKey, region: 'ap-shanghai' }) : null;

export async function login(): Promise<void> {
  if (!app) throw new Error('尚未配置云端环境');
  const session = await app.auth().getSession();
  if (session.error) throw new Error('无法核对登录状态，请重试');
  if (!session.data.session) {
    const result = await app.auth().signInAnonymously();
    if (result.error) throw new Error('访客登录暂时失败，请重试');
  }
}

async function request(command: Command | ChatCommand, rpc = 'gomoku_command'): Promise<unknown> {
  if (!app) throw new Error('尚未配置云端环境');
  const session = await app.auth().getSession();
  const token = session.data.session?.access_token;
  if (!token || session.error) throw new Error('登录已失效，请重新连接');
  const { response, body } = await fetchJsonWithTimeout(`https://${env}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/${rpc}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(command),
  }, 10_000);
  if (!response.ok) {
    throw rpcError(body);
  }
  return body;
}

export async function sendChat(command: ChatCommand): Promise<ChatSnapshot> {
  const body = await request(command, 'gomoku_chat');
  if (!isChatSnapshot(body)) throw new Error('聊天数据不完整，请重试');
  return body;
}

export async function send(command: Command): Promise<Reply> {
  const body = await request(command);
  if (!isReply(body)) throw new Error('返回数据不完整，请刷新重试');
  return body;
}

export async function inspectInvitation(command: Command): Promise<InvitationInfo> {
  const body = await request(command);
  if (!isInvitationInfo(body)) throw new Error('无法确认房间角色，请重试');
  return body;
}
