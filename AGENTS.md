# someclaw

Custom ZeroClaw web UI, always agent `rocky`. Architecture, install, deploy internals: README.md.

## Rules
- **Main only**: commit + push straight to `main`, no PRs, branches or worktrees.
- **Never edit the live checkout** (`~/.local/share/someclaw`): a dirty tree there stops updates. Work in a separate clone (`~/Source/someclaw`).
- **Stack**: React + TypeScript + Tailwind in `src/`, bundled by Bun (`build.ts`, no Vite) into `dist/`. `server.ts` serves `dist/`, proxies the gateway REST API and runs the broker (`server/`), which owns all gateway chat sockets; browser protocol in `shared/protocol.ts`.
- **Styling**: Tailwind classes only; `src/styles.css` holds just the `@theme` tokens (ZeroClaw palette, Inter/JetBrains Mono, radius scale) + base. Icons: lucide-react. Messages and composer share one column width. No hand-written CSS, no ad-hoc hex values.
- **Errors**: show real errors in the UI (status, message), no polished copy.
- **Not a full replacement**: anything unbuilt links to the official dashboard.
- **Composer** is a contenteditable (`src/components/Editor.tsx`), never back to a textarea: Firefox Android only gives keyboard/Gboard image paste to contenteditable.
- **Back must stay instant**: any new WebSocket/EventSource/long request registers with `src/lib/away.ts` (closes on leave, reopens on back; Firefox keeps pages with open or still-closing connections out of the back/forward cache). Page loads show the IndexedDB cache (`src/lib/cache.ts`) until the broker's fresh data arrives.
- **Outbox = one turn per message**, never joined (queued at a full window, scheduled, handoffs while busy): a turn's tool context grows, tokens matter.
- **Gateway API** changes between ZeroClaw releases: check `/api/openapi.json` of the running gateway (`curl -s 127.0.0.1:42617/api/openapi.json`), not memory.

## Develop
- `SOMECLAW_STATE_DIR=/tmp/sc-state bun run dev`: build --watch + server on 42699, real gateway, own state; open pages reload themselves. Stop it by PID, never `pkill -f` (matches your own shell).
- `bun run check` and `bun test` must pass before committing.
- **e2e** (headless Chromium + puppeteer-core): token from a test pairing, set localStorage `zeroclaw_token` + an e2e session id, never a real session. Delete e2e sessions after (`DELETE /api/sessions/<id>`). Test pairings leave a paired device behind.
- Firefox drops files from synthetic ClipboardEvents: e2e paste there via `navigator.clipboard.write` + Ctrl+V.
- Rate limit without a real limit: `SOMECLAW_USAGE_FILE=<fake usage json>` on the dev server; the poll caches, restart dev after editing it. "Send now" at a full window only shows with extra usage available. Auto-resume of a rate-limited turn: max 3 attempts, 5 min fallback when there's no reset time.

## Deploy
- Commit, then `bin/deploy` (~3 s): pushes main, runs `someclaw-update.service` now, checks live checkout + service. The 1-min timer only catches pushes made elsewhere.
- **UI-only** (`src/`, deps): no restart; open pages get the new version over SSE (`/someclaw/events`) and reload when idle.
- **Server code** (`server.ts`, `server/`, `shared/`) or unit changes restart the service. Safe mid-turn, deploy right away (also from inside a turn): the gateway keeps running the turn and the broker reattaches (`attach`, zeroclaw-patches 0004; read-only until it ends). ZeroClaw restarts kill the turn: the broker resends it once with the steps it already ran.
- Logs: `journalctl --user -u someclaw`, `journalctl --user -u someclaw-update`. Revert = `git revert` + push.
