// Back/forward cache: going back after following a link restores the page as it was, instead of a full reload. An open
// WebSocket or EventSource keeps a page out of it, and Firefox decides before pagehide, so connections close as soon
// as a link click starts leaving and reopen when the page comes back from the cache or turns out to stay. Still closing
// at navigation counts as open there: the click waits for them (max CLOSE_MS), then navigates itself.
type Hooks = { leave: () => void | Promise<unknown>; back: () => void };
const CLOSE_MS = 500;
const hooks = new Set<Hooks>();
let away = false;
let stay: Timer | undefined;

const leave = async () => {
  if (away) return;
  away = true;
  const closing = Promise.all([...hooks].map((h) => h.leave()));
  await Promise.race([closing, new Promise((r) => setTimeout(r, CLOSE_MS))]);
  await new Promise((r) => setTimeout(r)); // a just-closed EventSource still blocks within the same task (Firefox)
};
const back = () => {
  clearTimeout(stay);
  if (!away) return;
  away = false;
  hooks.forEach((h) => h.back());
};

/** leave: close connections, resolve once closed. back: reopen them (state may be stale, resubscribe). */
export function onAway(h: Hooks) {
  hooks.add(h);
  return () => void hooks.delete(h);
}

window.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!a || a.hasAttribute("download") || (a.target && a.target !== "_self")) return;
  const to = new URL(a.href, location.href);
  if (!/^https?:$/.test(to.protocol)) return;
  if (to.origin === location.origin && to.pathname === location.pathname && to.search === location.search) return; // #conversation
  e.preventDefault();
  leave().then(() => location.assign(to));
  // Still here (app link, download, cancelled): the next sign of use reconnects, else this.
  stay = setTimeout(back, 10_000);
});
window.addEventListener("pagehide", () => void leave());
window.addEventListener("pageshow", (e) => e.persisted && back());
window.addEventListener("pointerdown", back, true);
window.addEventListener("keydown", back, true);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && back());
