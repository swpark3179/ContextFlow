/** Date/label helpers. Ported from the design's `daysSince` / `qLabel`. */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `2026-08-03 15:30` — the stamp format written into frontmatter and Run Logs. */
export function nowStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function hhmm(): string {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `2026-08-03 15:30` → `08-03 15:30`, the compact form in the task list. */
export function shortStamp(full: string): string {
  if (!full) return "";
  const m = full.match(/^\d{4}-(\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  if (m) return `${m[1]} ${m[2]}`;
  const d = full.match(/^\d{4}-(\d{2}-\d{2})/);
  return d ? d[1] : full;
}

export function daysSince(date: string | null | undefined): number {
  if (!date) return 0;
  const then = new Date(`${date.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(then.getTime())) return 0;
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}

/** `2026-08-03` → `2026년 3분기`. */
export function qLabel(date: string): string {
  const safe = date && date.length >= 7 ? date : today();
  const month = parseInt(safe.slice(5, 7), 10);
  return `${safe.slice(0, 4)}년 ${Math.ceil(month / 3)}분기`;
}

export function basename(path: string): string {
  const clean = path.replace(/\/$/, "");
  return clean.split("/").pop() ?? clean;
}

export function dirname(path: string): string {
  const parts = path.replace(/\/$/, "").split("/");
  parts.pop();
  return parts.length ? parts.join("/") + "/" : "";
}

/** Vault root + relative path, always with forward slashes. */
export function joinPath(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, "/").replace(/\/+$/, ""))
    .join("/");
}
