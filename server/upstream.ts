// Is the served build at origin/main? The update timer (1 min) or bin/deploy normally keeps it there, so a build
// that stays behind means the update is stuck (dirty live checkout, failed install.sh, diverged branch, ...).
// Compares the commit dist/ was built from (build.ts writes dist/commit.txt) with `git ls-remote origin main`.
import type { Upstream } from "../shared/protocol";

const ROOT = `${import.meta.dir}/..`;
const POLL_MS = 60_000;
// Pushes made elsewhere reach the live checkout within the timer's minute: only report behind after that.
const GRACE_MS = 150_000;

let status: Upstream = { built: null, main: null, behind: false, commits: null, since: null, error: null };

async function git(...args: string[]) {
  const p = Bun.spawn(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { ok: code === 0, out: out.trim(), err: err.trim() || `git ${args[0]} exited ${code}` };
}

async function check() {
  try {
    const built = (await Bun.file(`${ROOT}/dist/commit.txt`).text().catch(() => "")).trim() || null;
    const remote = await git("ls-remote", "origin", "refs/heads/main");
    if (!remote.ok) throw new Error(`git ls-remote origin main: ${remote.err}`);
    const main = remote.out.split(/\s/)[0] || null;
    if (!main) throw new Error("git ls-remote origin main: no refs/heads/main");
    if (!built) throw new Error("dist/commit.txt missing: build predates the version check");

    // Ahead (dev clone with unpushed commits) isn't behind: only when main isn't contained in the build.
    let behind = main !== built && !(await git("merge-base", "--is-ancestor", main, built)).ok;
    let commits: number | null = null;
    if (behind) {
      const count = await git("rev-list", "--count", `${built}..${main}`); // fails when main isn't fetched yet
      commits = count.ok ? Number(count.out) : null;
    }
    const since = behind ? (status.main === main && status.since ? status.since : Date.now()) : null;
    status = { built, main, behind, commits, since, error: null };
  } catch (e) {
    status = { ...status, error: e instanceof Error ? e.message : String(e) };
  }
}

check();
setInterval(check, POLL_MS);

/** Recheck right away, e.g. after dist/ was rebuilt. */
export const recheck = () => void check();

/** Behind only once it lasted past the grace period. */
export const upstream = (): Upstream => ({
  ...status,
  behind: status.behind && status.since !== null && Date.now() - status.since > GRACE_MS,
});
