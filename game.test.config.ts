import { defineConfig } from 'vite';
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// 仅本地浏览器测试替换 API；正式构建使用 game.config.ts，不加载此适配器。
export default defineConfig({
  root: 'game', base: '/', envDir: '..',
  resolve: { alias: [{ find: './api', replacement: resolve('tests/game-e2e/api-local.ts') }] },
  server: { fs: { allow: [process.cwd()] } },
  plugins: [{
    name: 'local-postgresql-test',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(/(?:\/\.\.)?\/src\/game\/main.ts/, () => `/@fs/${resolve('src/game/main.ts').replaceAll('\\', '/')}`);
      },
    },
    async configureServer(server) {
      // 按迁移顺序安装真实 RPC，只模拟网关提供的身份函数，不用 JS 复刻游戏规则。
      const db = new PGlite();
      await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
        CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.uid',true) $$;
        CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'authenticated'::text $$;
        CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;`);
      for (const file of (await readdir('cloudbase/migrations')).sort().filter(f => f.includes('gomoku_mvp') || f.includes('undo_and_reactions') || f.includes('application_lifecycle') || f.includes('interaction_feedback') || f.includes('invitation_preview') || f.includes('resign') || f.includes('text_chat'))) {
        await db.exec(await readFile(`cloudbase/migrations/${file}`, 'utf8'));
      }
      const installed = await db.query<{ definition: string }>("SELECT pg_get_functiondef('public.gomoku_game_command(text,text,uuid,uuid,integer,uuid,jsonb,integer)'::regprocedure) AS definition");
      if (!installed.rows[0].definition.includes("s.reason:='resign'")) throw new Error('Latest game migration is missing from the local test server');
      // PGlite 共享一个数据库会话；身份设置和命令必须成对串行，避免并发请求串用玩家身份。
      let queue: Promise<unknown> = Promise.resolve();
      server.middlewares.use('/rpc', (req, res) => {
        const chat = req.url === '/gomoku_chat';
        if (!chat && req.url !== '/gomoku_command') { res.statusCode = 404; res.end(); return; }
        let body = '';
        req.on('data', chunk => { body += String(chunk); });
        req.on('end', () => {
          queue = queue.then(async () => {
            res.setHeader('Content-Type', 'application/json');
            try {
              const p = JSON.parse(body) as Record<string, unknown>;
              await db.query("SELECT set_config('request.uid',$1,false)", [req.headers['x-test-uid'] || '']);
              const result = chat ? await db.query<{ reply: unknown }>('SELECT public.gomoku_chat($1,$2,$3,$4) AS reply',
                [p.p_room,p.p_client,p.p_operation,p.p_text])
                : await db.query<{ reply: unknown }>('SELECT public.gomoku_command($1,$2,$3,$4,$5,$6,$7,$8) AS reply',
                  [p.p_room, p.p_action, p.p_client, p.p_operation, p.p_version, p.p_game, p.p_data, p.p_protocol]);
              res.end(JSON.stringify(result.rows[0].reply));
            } catch (error) {
              res.statusCode = 400; res.end(JSON.stringify({ message: error instanceof Error ? error.message : 'SQL failure' }));
            }
          });
        });
      });
      // 等待已入队命令完成再关库，避免测试服务器退出时中断正在处理的请求。
      server.httpServer?.once('close', () => { void queue.then(() => db.close()); });
    },
  }],
});
