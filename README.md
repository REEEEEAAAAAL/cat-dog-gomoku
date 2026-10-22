# Cat & Dog Gomoku

A private two-player browser Gomoku game built with TypeScript and Vite. Choose a dog or cat identity, share an invitation, approve your partner, and play on a 15×15 board. No account registration is needed.

The active backend is CloudBase PostgreSQL HTTP RPC. Visible pages poll every five seconds; peer updates can take one polling interval. Each command locks its room row, validates identity, game, version, turn and position, and persists state before returning a snapshot.

## Play

1. Choose an identity and optionally enter a nickname, then create a room.
2. Send the invitation link or ten-character room code to your partner. The host approves the joining player.
3. Both players select the ready button. Black plays first; initial colors are random.
4. On a phone, tap an intersection to preview, then confirm. Mouse clicks place directly. Arrow keys select a point; Enter previews, and the confirmation button submits.
5. Five or more connected stones win. A full board without a winning line is a draw. Both players must request another round; colors then swap while animal identities stay the same.

Your partner appears above the board, and you appear below it. The server allows 60 seconds per turn. Missing heartbeats pause play and preserve the remaining time; both players must reconnect and acknowledge synchronization within five minutes. Otherwise the round ends without a winner. Settlement is lazy on the next RPC when both players are absent. Refresh restores the room using the browser's native anonymous session. New tabs take over that browser's seat; the old tab is disabled. Explicitly leaving closes the room for both players. Rooms expire after 24 hours.

## Develop and verify

Use Node.js 22 or newer and npm. Node.js 24 is the verified development version.

```sh
npm ci
```

Copy `.env.example` to the ignored `.env.local` and configure the existing environment ID and a frontend publishable key. Never use management credentials in Vite variables.

```sh
npm run dev
npm run typecheck
npm run lint
npm test
npm run build:cloudbase
npm run test:game-page
npm run test:cloudbase-page
```

Scripts invoke Node entrypoints directly because Windows command shims can fail when the checkout path contains `&`. The game uses native DOM and SVG without a frontend framework. The CloudBase SDK produces the existing large-chunk Vite advisory; it does not prevent the build.

`npm test` uses isolated PGlite PostgreSQL instances and a controlled server clock, plus rule, HTTP timeout and legacy session tests. It needs no cloud credentials and makes no network calls. Browser tests use the installed Microsoft Edge. Live multiplayer checks require opt-in because they create disposable rooms and anonymous sessions in the configured environment:

```powershell
$env:GOMOKU_URL = 'https://your-existing-host/gomoku/'
npm run test:game-page

# Includes a real five-minute absence; allow about six minutes for that case.
$env:GOMOKU_LONG_TEST = '1'
npm run test:game-page
```

To check a local preview against the real configured backend, set `GOMOKU_LIVE_LOCAL=1` instead of `GOMOKU_URL`. Public automated browser checks do not establish mainland physical-device compatibility. New-game manual acceptance still requires two real phones and networks.

## Deploy to the existing free environment

`npm run build:cloudbase` only builds and packages files:

- `dist/cloudbase/game/`: game assets.
- `dist/cloudbase/site/`: preserved Stage 0 diagnostic page.
- `dist/cloudbase/database/`: versioned SQL migrations; do not upload this directory as a website.

With CloudBase CLI already authenticated to the intended domestic environment, inspect migrations, preview the additive changes, apply them, and verify recorded history. Never rewrite an applied migration.

```sh
tcb db pg migration list --env-id YOUR_EXISTING_ENV_ID
tcb db pg migration up --dry-run --env-id YOUR_EXISTING_ENV_ID
tcb db pg migration up --env-id YOUR_EXISTING_ENV_ID --yes
tcb db pg migration list --env-id YOUR_EXISTING_ENV_ID
tcb hosting deploy ./dist/cloudbase/game gomoku --env-id YOUR_EXISTING_ENV_ID --verify
```

Fragment-based invitations need no custom routing for refresh. This adds a `gomoku/` path to existing hosting without replacing `gomoku-diag/`, creating an environment, enabling Realtime, upgrading a plan or enabling overage. Keep existing hashed assets for recovery. Rebuilding and uploading a saved game build restores the frontend; leave additive migrations in place.

The current environment is a free trial with a finite validity period and quotas, not a promise of perpetual free hosting. Do not enable paid resources, automatic renewal or overage without authorization.

## Architecture and boundaries

`src/game/` owns rendering, protocol validation and native CloudBase sessions. The versioned `gomoku_command` RPC owns all game decisions. `gomoku_rooms` is separate from `gomoku_diag_probe`; browsers have no direct game-table read or write grants. Pending applicants receive no board data, and a third visitor cannot join a full room. Mutation receipts support safe retries after a lost acknowledgement. Uncertain operations remain visible for explicit retry instead of submitting another move silently.

The preserved diagnostic page validates visitor login, two-seat HTTP synchronization, server timers, disconnect recovery and access boundaries. Deploy it separately when necessary:

```sh
tcb hosting deploy ./dist/cloudbase/site gomoku-diag --env-id YOUR_EXISTING_ENV_ID --verify
```

An older Cloudflare Workers and SQLite Durable Objects candidate remains under `src/worker/`, `src/shared/` and the legacy client. Its scripts have the `:legacy-cloudflare` suffix and are not the active deployment path.

Undo, reactions and QR invitations are deferred. There is no AI opponent, matchmaking, spectator mode, chat or payment integration.

Never commit secrets, cookies, local environment files or internal acceptance records. `docs/internal/`, `.cloudbase/` and `.env.local` stay ignored. Follow `AGENTS.md` for development and authorization boundaries.
