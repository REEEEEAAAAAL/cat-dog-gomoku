import cloudbase from '@cloudbase/js-sdk';
import { fetchJsonWithTimeout } from '../../diagnostics/cloudbase/http';
import { errorMessage, isReply } from './protocol';
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
    const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string' ? body.message : '';
    const code = Object.keys({ not_found: 1, expired: 1, room_full: 1, forbidden: 1, unauthorized: 1, application_pending: 1,
      invalid_name: 1, superseded: 1, room_closed: 1, create_limit: 1, protocol_mismatch: 1 }).find(code => message.includes(code));
    throw new Error(code ? errorMessage(code) : '连接失败，请检查网络后重试');
  }
  if (!isReply(body)) throw new Error('返回数据不完整，请刷新重试');
  return body;
}
