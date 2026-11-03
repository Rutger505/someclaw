# someclaw

Custom web UI for [ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw), next to the official dashboard instead of replacing it. Bare-minimum for now: one chat, no sidebar.

- `index.html`: vanilla JS, no build step. Pairs via `POST /api/pair`, then talks to `/ws/chat` (`session_id` + `agent` + `token` query). Renders `chunk` / `done` / `tool_call` / `tool_result` / `error` events.
- `server.ts`: Bun server that serves `index.html` and proxies `/api/*`, `/health`, `/ws/chat` to the gateway, so everything is same-origin (the gateway has no CORS). `PORT` (default 42618), `ZEROCLAW_GATEWAY` (default `http://127.0.0.1:42617`).

## Install

Lives on the ZeroClaw VM in `~/.local/share/someclaw`, like dev-env. homelab-infrastructure's role `zeroclaw` clones it, runs `install.sh`, opens the port for the reverse proxy and routes https://someclaw.homelab.rutgerpronk.com to it. By hand:

```bash
git clone git@github.com:Rutger505/someclaw.git ~/.local/share/someclaw
~/.local/share/someclaw/install.sh
```

`install.sh` links `systemd/*` into `~/.config/systemd/user` and enables:

- `someclaw.service`: `bun server.ts`. Logs: `journalctl --user -u someclaw`.
- `someclaw-update.service`: `bin/someclaw-update` pushes local commits, fast-forwards to `origin/main`, reruns `install.sh` and restarts `someclaw.service` only if something besides `index.html`/docs changed. Refuses a dirty tree or a diverged branch (`journalctl --user -u someclaw-update`).
- `someclaw-update.timer`: fallback, runs it every 15 minutes.

## Deploy

`bin/deploy` from the dev clone: pushes main, runs `someclaw-update.service` right away, checks the live checkout and the service. `index.html` is read per request and open pages poll `/someclaw/version` (hash of `index.html`), reloading when no turn is running and the input is empty.

## Use

Open the URL, send a pairing code (`zeroclaw gateway get-paircode --new`) as the first message. `?agent=<alias>` picks another agent (default `rocky`). Its own origin, so it pairs separately from the official dashboard.

## Not done

- History of a resumed session isn't fetched (only the count is shown).
- No markdown, approvals or abort yet. The "official" link opens the official dashboard for everything else.
