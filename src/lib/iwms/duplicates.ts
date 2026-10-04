import type { IwmsCategory, IwmsDay, IwmsRow } from "./types";

/**
 * 이미 i-WMS 에 손으로 넣은 일인가 — 오늘의 한일 제목과 그날 i-WMS 행의 상세내용을 견준다.
 *
 * 2026-10-02 실데이터에서 오늘의 한일 일곱 줄 중 두 줄('SRM 인스턴스 문제건 조치' · '설계협력사 임직원 등록현황
 * 확인건')이 이미 i-WMS 에 손으로 들어가 있었다. 그대로 넣으면 같은 일이 두 번 잡힌다.
 *
 * 형태소 분석기 없이 한글을 견주는 최소 장치로 글자 2-gram 의 Dice 계수를 쓴다(바탕화면 `auto-wms` 의
 * `planner.rs` 와 같은 생각) — "확인건" · "확인 건" · "확인했다" 가 서로 겹친다.
 */

/** 이 이상이면 같은 일로 보고 기본으로 뺀다. */
export const SAME = 0.8;
/** 이 이상이면 비슷하다고 알린다. */
export const SIMILAR = 0.5;

export function grams(text: string): string[] {
  const s = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const chars = Array.from(s);
  if (chars.length < 2) return chars;
  return chars.slice(0, -1).map((c, i) => c + chars[i + 1]);
}

export function dice(a: string, b: string): number {
  const x = grams(a);
  const y = grams(b);
  if (!x.length || !y.length) return 0;
  const pool = new Map<string, number>();
  for (const g of y) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of x) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      hit += 1;
      pool.set(g, n - 1);
    }
  }
  return (2 * hit) / (x.length + y.length);
}

export interface Duplicate {
  category: IwmsCategory;
  row: IwmsRow;
  score: number;
}

/**
 * 제목과 가장 닮은 그날의 i-WMS 행. 상세내용의 첫 줄과 전체 중 높은 쪽을 쓴다 — 상세내용은 대개 첫 줄이
 * 제목이고 아래에 `- 세부` 가 붙는다. `SIMILAR` 아래면 `null`.
 */
export function duplicateOf(title: string, day: IwmsDay): Duplicate | null {
  let best: Duplicate | null = null;
  for (const category of day.categories) {
    for (const row of category.rows) {
      const first = row.note.split("\n")[0] ?? "";
      const score = Math.max(dice(title, first), dice(title, row.note));
      if (score >= SIMILAR && (!best || score > best.score)) best = { category, row, score };
    }
  }
  return best;
}
