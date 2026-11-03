# someclaw

- Commit + push straight to `main`, no PRs or branches.
- Stack: React + TypeScript + Tailwind in `src/`, bundled by Bun (`build.ts`, no Vite) into `dist/`. `server.ts` serves `dist/`, proxies the gateway REST API and runs the broker (`server/`), which owns all gateway chat sockets; browser protocol in `shared/protocol.ts`.
- Colors: only the theme tokens in `src/styles.css` (ZeroClaw dashboard palette), no ad-hoc hex values.
- Dev: `SOMECLAW_STATE_DIR=/tmp/sc-state bun run dev` (rebuilds on save, server on 42699; open pages reload themselves). `bun run check` must pass before committing.
- Deploy with `bin/deploy` after committing: pushes main and updates the live checkout right away. The 15-min timer is only a fallback.
- UI-only changes (`src/`, deps) need no restart; open pages get the new version over SSE (`/someclaw/events`) and reload when idle. Server code (`server.ts`, `server/`, `shared/`) or unit changes restart the service: running turns lose their socket and queues pause. Avoid while Rutger is mid-turn.
- Work in a separate clone (`~/Source/someclaw`), never in the live checkout: a dirty tree there stops updates.
- Show real errors in the UI (status, message), no polished copy.
- The gateway API changes between ZeroClaw releases: check `/api/openapi.json` of the running gateway, not memory.
