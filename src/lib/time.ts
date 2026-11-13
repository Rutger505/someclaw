/** Short local time: "17:00" today, "Sat 17:00" within a week, else "14 Nov 17:00". */
export function when(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const days = (d.getTime() - now.getTime()) / 86_400_000;
  if (days > -6 && days < 6) return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "in 2h 5m" / "in 3d 4h" until iso; "now" once passed. */
export function until(iso: string) {
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return "now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}
