# someclaw

- Commit + push straight to `main`, no PRs or branches.
- Stack: React + TypeScript + Tailwind in `src/`, bundled by Bun (`build.ts`, no Vite) into `dist/`. `server.ts` serves `dist/` and proxies the gateway.
- Colors: only the theme tokens in `src/styles.css` (ZeroClaw dashboard palette), no ad-hoc hex values.
- Dev: `bun run dev` (rebuilds on save, server on 42699; open pages reload themselves). `bun run check` must pass before committing.
- Deploy with `bin/deploy` after committing: pushes main and updates the live checkout right away. The 15-min timer is only a fallback.
- UI-only changes (`src/`, deps) need no restart; open pages get the new version over SSE (`/someclaw/events`) and reload when idle. `server.ts`/unit changes restart the service (drops open chats).
- Work in a separate clone (`~/Source/someclaw`), never in the live checkout: a dirty tree there stops updates.
- Show real errors in the UI (status, message), no polished copy.
- The gateway API changes between ZeroClaw releases: check `/api/openapi.json` of the running gateway, not memory.
