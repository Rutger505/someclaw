# someclaw

Custom web UI for [ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw), next to the official dashboard instead of replacing it. Always talks to agent `rocky`.

One chat pane, a sidebar with all of rocky's conversations (gateway sessions). Status dots, message queue, archive, auto-titles, keyboard shortcuts (Ctrl+/ lists them).

- `server/broker.ts`: owns one gateway `/ws/chat` socket per active conversation, so turns, queues and status survive tab switches, reloads and closed browsers. Browsers talk to it over `/someclaw/ws` (protocol in `shared/protocol.ts`): conversation list, snapshots (history + tool logs + running turn), live events.
  - List = `GET /api/sessions` for agent rocky (polled every 5 s while a browser is open) + `/api/sessions/running`. Empty sessions are hidden. Channel sessions (WhatsApp) are read-only: `/ws/chat` can't write into them.
  - Queue: sending while a turn runs queues it; the next turn starts on `done`. Steer (Alt+Enter, or "steer" on a queued item) sends into the running turn, the gateway folds it in. A stop, error or someclaw restart pauses the queue until "resume".
  - Auto-titles (`server/title.ts`): after the first reply, one turn of agent `titler` (cheap, tool-less, defined in zeroclaw-config) in a throwaway session, then `PUT /api/sessions/{id}` with the name. Until then the sidebar shows the first message.
  - Own state (archive, seen, queues, previews, tool logs: gateway history has no tool calls) as JSON in `~/.local/state/someclaw` (`SOMECLAW_STATE_DIR`). Also keeps the last valid browser token, so queues run with no browser open.
- `src/`: React + TypeScript + Tailwind (theme = the ZeroClaw dashboard palette, `src/styles.css`). Pairs via `POST /api/pair`. Keymap in `src/lib/shortcuts.ts`.
- `build.ts`: bundles `src/index.html` with `Bun.build` + `bun-plugin-tailwind` into `dist/` (swapped in atomically). `--watch` for dev.
- `server.ts`: Bun server: serves `dist/`, runs the broker, proxies `/api/*` + `/health` to the gateway (pairing; the gateway has no CORS). `PORT` (default 42618), `ZEROCLAW_GATEWAY` (default `http://127.0.0.1:42617`).

## Develop

```bash
bun install
bun run dev    # build --watch + server on :42699 (SOMECLAW_STATE_DIR=/tmp/... keeps test state out of the live one)
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
- `someclaw-update.service`: `bin/someclaw-update` pushes local commits, fast-forwards to `origin/main`, reruns `install.sh` (`bun install`, build, units) and restarts `someclaw.service` only if server code (`server.ts`, `server/`, `shared/`) or a unit changed. Refuses a dirty tree or a diverged branch (`journalctl --user -u someclaw-update`).
- `someclaw-update.timer`: fallback, runs it every 15 minutes.

## Deploy

`bin/deploy` from the dev clone: pushes main, runs `someclaw-update.service` right away, checks the live checkout and the service. The server watches `dist/` and pushes the hash of `dist/index.html` over SSE (`/someclaw/events`, also sent on connect, so a restart is caught on reconnect); open pages reload when no turn is running and the input is empty.

## Use

Open the URL, enter a pairing code (`zeroclaw gateway get-paircode --new`). Its own origin, so it pairs separately from the official dashboard.

## Shortcuts

Ctrl+1-9 open conversation 1-9 (sidebar order: newest created first, stable), Ctrl+O new, Alt+↑/↓ previous/next, Alt+A archive, Alt+R rename, Esc stop, Ctrl+B sidebar, Ctrl+L focus input, Ctrl+/ help. In the input: Enter send/queue, Alt+Enter steer. Browser tabs keep Ctrl+1-9: use an app window (Chromium `--app`, Omarchy web app).

## Not done

- Approvals. The "ZeroClaw dashboard" link opens the official dashboard for everything else.
- Tool calls of turns that ran outside someclaw (or before it kept tool logs) aren't shown: gateway history has none.
