// Cron results back into the conversation that created the job. ZeroClaw's cron_add only defaults delivery to the
// originating chat for channels (telegram, discord, ...); a /ws/chat turn gets delivery "none", so runs ended up only
// in its cron store (delivery=not_required). The broker sees the job id in the cron_add/schedule tool result, polls the
// job's runs and posts each one into the conversation (POST /api/sessions/{id}/messages: an assistant message in the
// transcript, so the model sees it on the next turn). Runs already delivered to a channel aren't posted again.
import { api, GatewayError } from "./gateway";
import { save, state } from "./state";
import { cronMessage, type GatewayEvent } from "../shared/protocol";

const POLL_MS = 10_000;
// Job missing from /api/cron this long (one-shot deleted after its run, or cron_remove): stop tracking. Not right away:
// a run row can land just after its job is gone.
const GONE_MS = 60_000;
const MAX_OUTPUT = 20_000;

type Run = { id: number; job_id: string; finished_at: string; status: string; output: string | null; delivery: string | null };

export type CronHooks = {
  /** A turn runs in the conversation: post later (the gateway would queue it into the running turn's transcript). */
  busy: (session: string) => boolean;
  /** Posted: refresh the list, push the new history to open browsers. */
  posted: (session: string) => void;
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Job id from a successful cron_add (JSON with id) or schedule ("Created one-shot job <id> ...") tool result. */
export function createdJob(e: GatewayEvent): { id: string; name: string | null } | null {
  const output = String(e.output ?? "");
  if (e.name === "cron_add") {
    try {
      const v = JSON.parse(output);
      return typeof v?.id === "string" ? { id: v.id, name: typeof v.name === "string" ? v.name : null } : null;
    } catch {
      return null; // error text
    }
  }
  if (e.name === "schedule") {
    const m = /^Created (?:recurring|one-shot) job (\S+)/.exec(output);
    return m ? { id: m[1]!, name: null } : null;
  }
  return null;
}

export function trackCron(session: string, e: GatewayEvent) {
  const job = createdJob(e);
  if (!job || state.cron[job.id]) return;
  state.cron[job.id] = { session, name: job.name, since: new Date().toISOString(), lastRun: 0 };
  save();
  console.log(`cron: tracking job ${job.id}${job.name ? ` (${job.name})` : ""} for ${session}`);
}

async function poll(hooks: CronHooks) {
  const token = state.token;
  const ids = Object.keys(state.cron);
  if (!token || !ids.length) return;
  const { jobs } = await api<{ jobs: { id: string }[] }>(token, "/api/cron");
  const live = new Set(jobs.map((j) => j.id));
  for (const id of ids) {
    const t = state.cron[id]!;
    try {
      let runs: Run[] = [];
      try {
        runs = (await api<{ runs: Run[] }>(token, `/api/cron/${encodeURIComponent(id)}/runs?limit=20`)).runs;
      } catch (e) {
        if (!(e instanceof GatewayError && e.status === 404)) throw e; // 404: no job and no retained runs
      }
      const fresh = runs.filter((r) => r.id > t.lastRun).sort((a, b) => a.id - b.id);
      if (fresh.length && hooks.busy(t.session)) continue;
      for (const r of fresh) {
        if (r.delivery !== "delivered") {
          const output = (r.output ?? "").trim() || "(no output)";
          const content = cronMessage(
            { job: id, name: t.name, run: r.id, status: r.status, at: r.finished_at },
            output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n[... ${output.length - MAX_OUTPUT} chars cut]` : output,
          );
          try {
            await api(token, `/api/sessions/${encodeURIComponent(t.session)}/messages`, { method: "POST", body: JSON.stringify({ content }) });
          } catch (e) {
            if (e instanceof GatewayError && e.status === 404) {
              console.error(`cron: job ${id}: conversation ${t.session} is gone, untracking`);
              delete state.cron[id];
              save();
              break;
            }
            throw e;
          }
          console.log(`cron: job ${id} run ${r.id} (${r.status}) posted into ${t.session}`);
          if (t.session in state.archived) delete state.archived[t.session]; // new activity: back in the list
          hooks.posted(t.session);
        }
        t.lastRun = r.id;
        save();
      }
      if (!state.cron[id]) continue;
      if (live.has(id)) {
        if (t.goneSince) {
          delete t.goneSince;
          save();
        }
      } else if (!fresh.length) {
        t.goneSince ??= new Date().toISOString();
        if (Date.now() - Date.parse(t.goneSince) > GONE_MS) {
          console.log(`cron: job ${id} gone, untracking`);
          delete state.cron[id];
        }
        save();
      }
    } catch (e) {
      console.error(`cron: job ${id}:`, msg(e)); // gateway down etc.: retried next poll
    }
  }
}

let lastError = "";
let timer: Timer | undefined;
let running: Promise<void> | null = null;
let again = false;

/** Polls now (gateway cron_result frame: a job just ran) instead of at the next tick. */
export function pollCronNow() {
  if (running) again = true;
  else run();
}

function run() {
  clearTimeout(timer);
  running = (async () => {
    try {
      await poll(hooks!);
      lastError = "";
    } catch (e) {
      if (msg(e) !== lastError) console.error("cron: poll:", (lastError = msg(e)));
    }
  })().finally(() => {
    running = null;
    if (again) {
      again = false;
      return run();
    }
    timer = setTimeout(run, POLL_MS);
  });
}

let hooks: CronHooks | undefined;
export function startCronPoller(h: CronHooks) {
  hooks = h;
  run();
}
