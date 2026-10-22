import cloudbase from '@cloudbase/js-sdk';
import { fetchJsonWithTimeout } from '../../diagnostics/cloudbase/http';
import { isReply, rpcError } from './protocol';
import type { Command, Reply } from './protocol';

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

export async function send(command: Command): Promise<Reply> {
  if (!app) throw new Error('尚未配置云端环境');
  const session = await app.auth().getSession();
  const token = session.data.session?.access_token;
  if (!token || session.error) throw new Error('登录已失效，请重新连接');
  const { response, body } = await fetchJsonWithTimeout(`https://${env}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/gomoku_command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(command),
  }, 10_000);
  if (!response.ok) {
    throw rpcError(body);
  }
  if (!isReply(body)) throw new Error('返回数据不完整，请刷新重试');
  return body;
}
