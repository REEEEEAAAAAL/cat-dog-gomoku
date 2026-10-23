import { defineConfig } from 'vite';
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

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
      const db = new PGlite();
      await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
        CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('request.uid',true) $$;
        CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'authenticated'::text $$;
        CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;`);
      for (const file of (await readdir('cloudbase/migrations')).sort().filter(f => f.includes('gomoku_mvp') || f.includes('undo_and_reactions') || f.includes('application_lifecycle') || f.includes('interaction_feedback'))) {
        await db.exec(await readFile(`cloudbase/migrations/${file}`, 'utf8'));
      }
      const installed = await db.query<{ definition: string }>("SELECT pg_get_functiondef('public.gomoku_command(text,text,uuid,uuid,integer,uuid,jsonb,integer)'::regprocedure) AS definition");
      if (!installed.rows[0].definition.includes('undoDenied')) throw new Error('Latest game migration is missing from the local test server');
      let queue: Promise<unknown> = Promise.resolve();
      server.middlewares.use('/rpc/gomoku_command', (req, res) => {
        let body = '';
        req.on('data', chunk => { body += String(chunk); });
        req.on('end', () => {
          queue = queue.then(async () => {
            res.setHeader('Content-Type', 'application/json');
            try {
              const p = JSON.parse(body) as Record<string, unknown>;
              await db.query("SELECT set_config('request.uid',$1,false)", [req.headers['x-test-uid'] || '']);
              const result = await db.query<{ reply: unknown }>('SELECT public.gomoku_command($1,$2,$3,$4,$5,$6,$7,$8) AS reply',
                [p.p_room, p.p_action, p.p_client, p.p_operation, p.p_version, p.p_game, p.p_data, p.p_protocol]);
              res.end(JSON.stringify(result.rows[0].reply));
            } catch (error) {
              res.statusCode = 400; res.end(JSON.stringify({ message: error instanceof Error ? error.message : 'SQL failure' }));
            }
          });
        });
      });
      server.httpServer?.once('close', () => { void queue.then(() => db.close()); });
    },
  }],
});
