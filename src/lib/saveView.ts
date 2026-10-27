/**
 * 문서 하나의 저장 표시. 탭의 점 · 텍스트 에디터의 상태 막대 · 뷰어 머리띠가 같은 규칙으로 읽는다 —
 * 셋이 따로 판단하면 탭은 체크인데 막대는 "미저장" 인 화면이 생긴다.
 *
 * 미저장 여부는 버퍼(`text !== saved`)에서, 저장 중 · 실패는 스토어의 `docSave` 에서 온다.
 */

/** `State.docSave` 의 한 칸과 같은 모양(스토어를 끌어오지 않으려고 여기에 다시 적는다). */
export interface SaveLike {
  state: "saving" | "saved" | "failed";
  at: string;
  error?: string;
  n: number;
}

export type SaveView = "dirty" | "saving" | "failed" | "saved";

/**
 * 지금 보여 줄 저장 상태. 쓰는 중이 가장 앞선다 — 쓰는 사이에 친 글자는 쓰기가 끝난 뒤 다시
 * "미저장" 이 된다. 실패는 **아직 미저장일 때만** 실패다: 그 뒤 다른 길(다시 읽기 · 되돌려 친 글)로
 * 버퍼가 디스크와 같아졌으면 더 붙잡을 것이 없다.
 */
export function saveView(dirty: boolean, save: SaveLike | undefined): SaveView {
  if (save?.state === "saving") return "saving";
  if (dirty) return save?.state === "failed" ? "failed" : "dirty";
  return "saved";
}

/** "저장됨 HH:MM" 의 시각 — 이 문서의 마지막 저장, 이번 업무에서 아직 저장한 적이 없으면 스냅샷 시각. */
export function savedAt(save: SaveLike | undefined, fallback: string): string {
  return save?.at || fallback;
}

/**
 * 탭의 체크를 다시 튀길 때인가. 저장이 끝날 때마다 `n` 이 오르고, 업무를 바꾸면 `docSave` 가 비워져
 * 0 으로 돌아간다 — 줄어든 것은 저장이 아니다.
 */
export function savedAgain(prev: number, next: number): boolean {
  return next > prev;
}
