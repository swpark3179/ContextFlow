/**
 * 목록에서 빠지는 줄을 잠깐 옛 자리에 남긴다 — 접히며 나가는 동안 아래 줄이 한 번에 튀어 오르지 않게.
 *
 * 카테고리를 지정 · 이동해 목록에서 사라지는 업무가 쓴다(`CategoryModal`). 새 목록의 순서를 그대로 지키고,
 * 빠진 줄은 옛 목록에서 바로 앞에 있던 살아 있는 줄 뒤에 끼운다(앞에 아무것도 없었으면 맨 앞).
 */

export interface Kept<T> {
  item: T;
  /** 새 목록에는 없다 — 접히며 나가는 중. */
  leaving: boolean;
}

export function withLeaving<T>(prev: readonly T[], next: readonly T[], key: (t: T) => string): Kept<T>[] {
  const live = new Set(next.map(key));
  /** 살아 있는 줄의 열쇠(맨 앞은 `null`) → 그 뒤에 있던 빠진 줄들. */
  const after = new Map<string | null, T[]>();
  const seen = new Set<string>();
  let anchor: string | null = null;
  for (const p of prev) {
    const k = key(p);
    if (seen.has(k)) continue;
    seen.add(k);
    if (live.has(k)) {
      anchor = k;
      continue;
    }
    const list = after.get(anchor) ?? [];
    list.push(p);
    after.set(anchor, list);
  }
  const out: Kept<T>[] = (after.get(null) ?? []).map((item) => ({ item, leaving: true }));
  for (const n of next) {
    out.push({ item: n, leaving: false });
    for (const d of after.get(key(n)) ?? []) out.push({ item: d, leaving: true });
    after.delete(key(n));
  }
  return out;
}
