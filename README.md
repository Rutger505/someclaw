# someclaw

Custom web UI for [ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw), next to the official dashboard instead of replacing it. Always talks to agent `rocky`.

One chat pane, a sidebar with all of rocky's conversations (gateway sessions). Status dots, steering, copy message, reset to here, archive, auto-titles, keyboard shortcuts (Ctrl+/ lists them).

- `server/broker.ts`: owns one gateway `/ws/chat` socket per active conversation, so turns and status survive tab switches, reloads and closed browsers. Browsers talk to it over `/someclaw/ws` (protocol in `shared/protocol.ts`): conversation list, snapshots (history + tool logs + running turn), live events.
  - List = `GET /api/sessions` for agent rocky (polled every 5 s while a browser is open) + `/api/sessions/running`. Empty sessions are hidden. Channel sessions (WhatsApp) are read-only: `/ws/chat` can't write into them. The composer starts locked (Continue here button, mouse only, or Ctrl+Shift+F; Esc on an empty draft relocks). Sending there forks: a new web conversation whose first message carries the thread's latest messages as a hidden `<continued-from>` block (`shared/protocol.ts`). Channel session ids are fixed per contact; a changed `created_at` drops their archive/title/preview state.
  - No queue: a message sent while rocky works goes straight into the running turn (steer, the gateway folds it in). A turn that is just finishing gets a new turn instead.
  - Reset to here (`server/sessions.ts`): deletes every message after the clicked one, rocky's context included. The gateway API can't truncate, so the broker deletes the rows in its SQLite session store (`~/.zeroclaw/data/sessions/sessions.db`, `ZEROCLAW_SESSIONS_DB`) like its own `rewrite_messages`, and closes its gateway socket so the next turn seeds from the shortened transcript. Refused while a turn runs or when the stored history no longer matches what the browser showed. Check the schema after ZeroClaw upgrades.
  - Auto-titles (`server/title.ts`): after the first reply, one turn of agent `titler` (cheap, tool-less, defined in zeroclaw-config) in a throwaway session, then `PUT /api/sessions/{id}` with the name. Until then the sidebar shows the first message. Channel sessions: retitled from their latest messages once activity settles (2 min); a rename here or in the dashboard sticks.
  - Cron results (`server/cron.ts`): ZeroClaw delivers cron output only to channels (WhatsApp, ...), never back to a `/ws/chat` conversation (delivery stays `not_required`). The broker picks the job id out of a `cron_add`/`schedule` tool result, polls `/api/cron/{id}/runs` (10 s, right away on the gateway's `cron_result` frame) and posts each run into that conversation via `POST /api/sessions/{id}/messages`: an assistant message in a `<cron-run>` block, shown as a cron card, seen by the model on the next turn. Runs already delivered to a channel aren't posted; waits while a turn runs there; unarchives it. Jobs made outside a someclaw turn aren't tracked.
  - Pinned skills (`server/skills.ts`): `/ws/chat` history keeps no tool results, so a SKILL.md rocky read with `read_skill` is gone next turn. Skills read in a conversation (from its tool logs, max 3, most recent) are pinned: the broker puts their current SKILL.md before the next user message (`<loaded-skill>` block, hidden in the UI, "sent along" tag) when that version (hash) isn't in the history yet. Chips in the header unpin; reading it again pins it again. Reset drops pins of deleted turns. `SOMECLAW_SKILLS_DIR` (default rocky's workspace skills).
  - Own state (archive, seen, previews, tool logs: gateway history has no tool calls) as JSON in `~/.local/state/someclaw` (`SOMECLAW_STATE_DIR`). Also keeps the last valid browser token, so turns finish with no browser open.
  - Attachments (`server/uploads.ts`, `shared/attachments.ts`): paperclip, paste or drop. `POST /someclaw/upload` (pairing token, max 50 MB) saves to `~/.zeroclaw/agents/rocky/workspace/uploads/<date>/` (`SOMECLAW_UPLOAD_DIR`; untracked, outside the config repo whitelist). `/ws/chat` takes text only, so the message carries ZeroClaw's channel media markers: `[IMAGE:<path>]` (vision) or `[Document: <name>] <path>` per line before the text. The UI renders leading markers as chips.
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

Restarts mid-turn: the broker writes each running turn (prompt + tool steps) to `inflight/` in the state dir as it goes. A someclaw restart doesn't stop the turn (the gateway finishes a /ws/chat turn without its socket): the broker reattaches, waits for it to end and files the steps it saw. A ZeroClaw restart kills it and the gateway stores nothing of it: the broker resends the prompt once with those steps (`<cut-off-turn>` block, hidden in the UI), so it continues instead of starting over.

## Use

Open the URL, enter a pairing code (`zeroclaw gateway get-paircode --new`). Its own origin, so it pairs separately from the official dashboard.

## Shortcuts

Ctrl+1-9 open conversation 1-9 (sidebar order: newest created first, stable), Ctrl+O new, Ctrl+↑/↓ previous/next, Ctrl+Shift+E archive, F2 rename, Esc stop, Ctrl+B sidebar, Ctrl+L focus input, Ctrl+/ help. In the input: Enter send (steers while rocky works). The sidebar shows each number before the title. Browser tabs keep Ctrl+1-9: use an app window (Chromium `--app`, Omarchy web app).

## Not done

- Approvals. The "ZeroClaw dashboard" link opens the official dashboard for everything else.
- Tool calls of turns that ran outside someclaw (or before it kept tool logs) aren't shown: gateway history has none.
