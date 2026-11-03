# someclaw

Custom web UI for [ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw), next to the official dashboard instead of replacing it. Always talks to agent `rocky`.

- `src/`: React + TypeScript + Tailwind (theme = the ZeroClaw dashboard palette, `src/styles.css`). Pairs via `POST /api/pair`, then talks to `/ws/chat` (`session_id` + `agent` + `token` query). Renders `chunk` / `done` / `tool_call` / `tool_result` / `error` events, markdown via `marked`.
- `build.ts`: bundles `src/index.html` with `Bun.build` + `bun-plugin-tailwind` into `dist/` (swapped in atomically). `--watch` for dev.
- `server.ts`: Bun server that serves `dist/` and proxies `/api/*`, `/health`, `/ws/chat` to the gateway, so everything is same-origin (the gateway has no CORS). `PORT` (default 42618), `ZEROCLAW_GATEWAY` (default `http://127.0.0.1:42617`).

## Develop

```bash
bun install
bun run dev    # build --watch + server on :42699
bun run check  # tsc
```

## Install

Lives on the ZeroClaw VM in `~/.local/share/someclaw`, like dev-env. homelab-infrastructure's role `zeroclaw` clones it, runs `install.sh`, opens the port for the reverse proxy and routes https://someclaw.homelab.rutgerpronk.com to it. By hand:

```bash
git clone git@github.com:Rutger505/someclaw.git ~/.local/share/someclaw
~/.local/share/someclaw/install.sh
```

`install.sh` links `systemd/*` into `~/.config/systemd/user` and enables:

- `someclaw.service`: `bun server.ts`. Logs: `journalctl --user -u someclaw`.
- `someclaw-update.service`: `bin/someclaw-update` pushes local commits, fast-forwards to `origin/main`, reruns `install.sh` (`bun install`, build, units) and restarts `someclaw.service` only if `server.ts` or a unit changed. Refuses a dirty tree or a diverged branch (`journalctl --user -u someclaw-update`).
- `someclaw-update.timer`: fallback, runs it every 15 minutes.

## Deploy

`bin/deploy` from the dev clone: pushes main, runs `someclaw-update.service` right away, checks the live checkout and the service. The server watches `dist/` and pushes the hash of `dist/index.html` over SSE (`/someclaw/events`, also sent on connect, so a restart is caught on reconnect); open pages reload when no turn is running and the input is empty.

## Use

Open the URL, enter a pairing code (`zeroclaw gateway get-paircode --new`). Its own origin, so it pairs separately from the official dashboard.

## Not done

- History of a resumed session isn't fetched (only the count is shown).
- No approvals or abort yet. The "official" link opens the official dashboard for everything else.
