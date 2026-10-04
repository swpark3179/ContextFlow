import { isWithin, keyOf } from "../category";
import { categoryKey, type Designated, type IwmsCategory, type IwmsDay, type Price } from "./types";

/**
 * 어느 i-WMS 카테고리에 넣을 수 있는가 — 순수 함수.
 *
 * 후보는 세 겹으로 거른다: **그날 입력 가능한 것**(i-WMS 의 '나의 MH 설정' 에 등록돼 있고 막히지
 * 않은 것) ∩ **대가 구분이 같은 것**(`priceType`) ∩ **설정에서 지정한 것**. 그 대가 구분에 지정한
 * 카테고리가 하나도 없으면 셋째 겹을 빼고 그날 그 구분의 전체로 대신한다 — 아무것도 고를 수 없는 것보다
 * 낫고, 화면이 그렇다고 알린다(`fallback`).
 */

export interface Candidates {
  list: IwmsCategory[];
  /** 지정한 카테고리가 없어 그날 그 대가 구분의 전체로 대신했다. */
  fallback: boolean;
  /** 지정했지만 그날 없거나 막힌 카테고리 — 화면이 흐리게 알린다. */
  missing: Designated[];
}

export function candidatesFor(day: IwmsDay, price: Price, designated: Designated[]): Candidates {
  const open = day.categories.filter((c) => c.priceType === price && !c.blocked);
  const mine = designated.filter((d) => d.priceType === price);
  if (!mine.length) return { list: open, fallback: true, missing: [] };

  const openKeys = new Set(open.map(categoryKey));
  const mineKeys = new Set(mine.map(categoryKey));
  return {
    list: open.filter((c) => mineKeys.has(categoryKey(c))),
    fallback: false,
    missing: mine.filter((d) => !openKeys.has(categoryKey(d))),
  };
}

/**
 * ContextFlow 업무 카테고리로 정해지는 i-WMS 카테고리. 지정한 카테고리의 `mapFrom` 중 업무 카테고리를
 * (하위까지) 품는 것을 찾고, 여럿이면 **가장 깊은 것**이 이긴다 — `프로젝트` 보다 `프로젝트/S-PCS-Plus`.
 * 대가 구분이 다른 매핑은 보지 않는다(같은 업무 카테고리를 대가포함 · 미포함에 하나씩 매핑할 수 있다).
 */
export function mappedCategory(
  taskCategory: string | null,
  designated: Designated[],
  price: Price,
): Designated | null {
  if (!taskCategory) return null;
  let best: { d: Designated; depth: number } | null = null;
  for (const d of designated) {
    if (d.priceType !== price) continue;
    for (const from of d.mapFrom) {
      const key = keyOf(from);
      if (!key || !isWithin(taskCategory, key)) continue;
      const depth = key.split("/").length;
      if (!best || depth > best.depth) best = { d, depth };
    }
  }
  return best?.d ?? null;
}

/** 지정 목록에서 한 카테고리를 켜거나 끈다. 끌 때 힌트 · 매핑 · 샘플도 함께 사라진다. */
export function toggleDesignated(list: Designated[], next: Designated, on: boolean): Designated[] {
  const key = categoryKey(next);
  const rest = list.filter((d) => categoryKey(d) !== key);
  return on ? [...rest, next] : rest;
}

/** 지정 목록의 한 항목을 고친다. 없는 키면 그대로. */
export function patchDesignated(
  list: Designated[],
  key: string,
  patch: Partial<Pick<Designated, "hint" | "mapFrom" | "samples">>,
): Designated[] {
  return list.map((d) => (categoryKey(d) === key ? { ...d, ...patch } : d));
}
