export const publicGameEntry = 'https://cat-dog-gomoku.us.ci/';

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/** 生成邀请链接。查询参数沿用当前页面，房间码留在片段中，浏览器跳转时会将其带到游戏页面。 */
export function invitationUrl(current: URL, code: string, entry = publicGameEntry): string {
  const useCurrentPage = import.meta.env.DEV || localHosts.has(current.hostname);
  const target = new URL(useCurrentPage ? current : entry);
  target.search = current.search;
  target.hash = code;
  return target.href;
}
