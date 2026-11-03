// Bundles src/index.html (React + Tailwind) into dist/. The server only serves dist/, so a UI build never restarts it.
// --watch rebuilds on every src/ change (dev).
import tailwind from "bun-plugin-tailwind";
import { rmSync, watch } from "node:fs";

const root = import.meta.dir;

async function build() {
  const t = performance.now();
  rmSync(`${root}/dist.tmp`, { recursive: true, force: true });
  const res = await Bun.build({
    entrypoints: [`${root}/src/index.html`],
    outdir: `${root}/dist.tmp`,
    plugins: [tailwind],
    minify: true,
    sourcemap: "linked",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!res.success) {
    for (const l of res.logs) console.error(l);
    return false;
  }
  // swap in one rename so the server never serves a half-written dist/
  rmSync(`${root}/dist`, { recursive: true, force: true });
  (await import("node:fs")).renameSync(`${root}/dist.tmp`, `${root}/dist`);
  console.log(`built dist/ in ${Math.round(performance.now() - t)} ms`);
  return true;
}

const ok = await build();
if (process.argv.includes("--watch")) {
  let timer: Timer | undefined;
  watch(`${root}/src`, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(build, 100);
  });
} else if (!ok) process.exit(1);
