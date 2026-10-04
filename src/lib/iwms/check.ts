import type { Draft } from "./parse";
import { NOTE_MAX } from "./prompts";
import type { IwmsDay, NewRow } from "./types";

/** 하루 상한 — i-WMS 화면이 저장 전에 막는 유일한 값(Rust `day::DAY_LIMIT`). */
export const DAY_LIMIT = 1440;

/**
 * 미리보기 전에 사람이 고쳐야 할 것 — 백엔드도 같은 것을 막지만(`day::plan_append`) 여기서 먼저 줄마다 짚는다.
 * 빈 목록이면 미리볼 수 있다.
 */
export function problemsOf(drafts: Draft[], day: IwmsDay | null): string[] {
  const out: string[] = [];
  if (!day) return ["i-WMS 현황을 읽지 못했습니다"];
  if (day.approved) out.push("결재가 끝난 날이라 입력할 수 없습니다");
  if (!drafts.length) out.push("넣을 업무가 없습니다");
  for (const d of drafts) {
    const who = `‘${d.title}’`;
    if (!d.category) out.push(`${who}: 카테고리를 고르세요`);
    else if (d.category.blocked) out.push(`${who}: ${d.category.blocked}`);
    if (d.minutes <= 0) out.push(`${who}: 분을 넣으세요`);
    if (!d.note.trim()) out.push(`${who}: 상세 내용이 비어 있습니다`);
    if (d.note.length > NOTE_MAX) out.push(`${who}: 상세 내용이 ${NOTE_MAX}자를 넘습니다`);
  }
  const after = day.totalMinutes + drafts.reduce((n, d) => n + Math.max(0, d.minutes), 0);
  if (after > DAY_LIMIT) out.push(`하루 합계가 ${after}분이 되어 ${DAY_LIMIT}분을 넘습니다`);
  return out;
}

/** 초안 → 덧붙일 행. 카테고리가 없는 줄은 뺀다(`problemsOf` 가 먼저 막는다). */
export function rowsOf(drafts: Draft[]): NewRow[] {
  return drafts.flatMap((d) =>
    d.category
      ? [
          {
            entryId: d.entryId,
            title: d.title,
            ciKey: d.category.ciKey,
            wbsid: d.category.wbsid,
            minutes: d.minutes,
            note: d.note.trim(),
            reqDate: "",
            price: d.price,
          },
        ]
      : [],
  );
}
