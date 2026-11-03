# someclaw

- Commit + push straight to `main`, no PRs or branches.
- A push is live within a minute: the VM's update timer fast-forwards `~/.local/share/someclaw` and restarts the service. Test first on another port: `PORT=42699 bun server.ts`.
- Work in a separate clone (`~/Source/someclaw`), never in the live checkout: a dirty tree there stops updates.
- No build step, no dependencies unless they clearly pay off.
- Show real errors in the UI (status, message), no polished copy.
- The gateway API changes between ZeroClaw releases: check `/api/openapi.json` of the running gateway, not memory.
