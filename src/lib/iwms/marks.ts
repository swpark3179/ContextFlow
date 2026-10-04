import type { DayEntry } from "../daylog";
import type { IwmsMark, IwmsPush, Price } from "./types";

/**
 * 오늘의 한일 팝업의 i-WMS 표시 — 순수 함수.
 *
 * 줄마다 고른 대가 구분(`IwmsMark`)과 이미 i-WMS 에 넣은 행(`IwmsPush`)을 줄 id 로 묶는다.
 */

export function markMap(marks: IwmsMark[]): Map<number, Price> {
  return new Map(marks.map((m) => [m.entryId, m.price]));
}

/** 되돌리지 않은 입력을 줄 id 별로. */
export function pushesByEntry(pushes: IwmsPush[]): Map<number, IwmsPush[]> {
  const out = new Map<number, IwmsPush[]>();
  for (const p of pushes) {
    if (p.undoneAt || p.entryId === null) continue;
    out.set(p.entryId, [...(out.get(p.entryId) ?? []), p]);
  }
  return out;
}

export interface Target {
  entry: DayEntry;
  price: Price;
  /** 이미 넣은 행(되돌리지 않은 것). 있으면 검토 화면이 기본으로 빼 둔다. */
  pushed: IwmsPush[];
}

/** 대가 구분을 고른 줄 — 팝업의 순서(최근 먼저) 그대로. */
export function targetsOf(entries: DayEntry[], marks: IwmsMark[], pushes: IwmsPush[]): Target[] {
  const m = markMap(marks);
  const p = pushesByEntry(pushes);
  return entries.flatMap((entry) => {
    const price = m.get(entry.id);
    return price ? [{ entry, price, pushed: p.get(entry.id) ?? [] }] : [];
  });
}

/** 낙관적 갱신 없이 커맨드가 성공한 뒤 목록에 반영한다. */
export function withMark(marks: IwmsMark[], entryId: number, price: Price | null): IwmsMark[] {
  const rest = marks.filter((m) => m.entryId !== entryId);
  return price ? [...rest, { entryId, price }] : rest;
}
