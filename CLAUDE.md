# someclaw

- Commit + push straight to `main`, no PRs or branches.
- Deploy with `bin/deploy` after committing: pushes main and updates the live checkout right away. The 15-min timer is only a fallback. Test first on another port: `PORT=42699 bun server.ts`.
- index.html changes need no restart; open pages poll `/someclaw/version` and reload when idle. server.ts/unit changes restart the service (drops open chats).
- Work in a separate clone (`~/Source/someclaw`), never in the live checkout: a dirty tree there stops updates.
- No build step, no dependencies unless they clearly pay off.
- Show real errors in the UI (status, message), no polished copy.
- The gateway API changes between ZeroClaw releases: check `/api/openapi.json` of the running gateway, not memory.
