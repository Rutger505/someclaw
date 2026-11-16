// Bundles src/index.html (React + Tailwind) into dist/. The server only serves dist/, so a UI build never restarts it.
// --watch rebuilds on every src/ or shared/ change (dev).
import tailwind from "bun-plugin-tailwind";
import { cpSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";

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
  // public/: PWA manifest + icons, fixed names (served no-cache). Linked here: Bun's HTML bundler tries to resolve
  // every <link href> in src/index.html as a file to bundle.
  cpSync(`${root}/public`, `${root}/dist.tmp`, { recursive: true });
  const html = `${root}/dist.tmp/index.html`;
  const links = '<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';
  writeFileSync(html, readFileSync(html, "utf8").replace("</head>", `${links}</head>`));
  // swap in one rename so the server never serves a half-written dist/
  rmSync(`${root}/dist`, { recursive: true, force: true });
  (await import("node:fs")).renameSync(`${root}/dist.tmp`, `${root}/dist`);
  console.log(`built dist/ in ${Math.round(performance.now() - t)} ms`);
  return true;
}

const ok = await build();
if (process.argv.includes("--watch")) {
  let timer: Timer | undefined;
  // shared/ is bundled into the UI too, public/ copied.
  for (const dir of ["src", "shared", "public"])
    watch(`${root}/${dir}`, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(build, 100);
    });
} else if (!ok) process.exit(1);
