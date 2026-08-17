/** 텍스트 에디터의 줄 단위 편집 — 지금은 Ctrl+X 줄 잘라내기 하나뿐이다. */

export interface LineCut {
  /** 잘라낼 구간 `[from, to)`. 그대로 선택해 두면 네이티브 잘라내기가 이 범위를 가져간다. */
  from: number;
  to: number;
  /** 클립보드에 올라갈 텍스트. 구간을 그대로 뜬 것이라 붙여넣으면 잘라내기 전으로 돌아온다. */
  text: string;
  /** 잘라낸 뒤 남는 본문 전체. */
  next: string;
}

/**
 * 커서가 놓인 줄 하나를 통째로 잘라낸다. 잘라낸 텍스트에는 **줄 끝 개행이 함께**
 * 들어간다 — 개행을 두고 가면 줄은 사라지지 않고 빈 줄로 남는다.
 *
 * 마지막 줄에는 딸려 나갈 개행이 없으므로 앞의 개행을 대신 가져온다. 그래서 문서
 * 끝에서 잘라내도 빈 줄 하나가 남지 않고, 캐럿은 앞 줄 끝에 붙는다.
 *
 * 잘라낼 것이 없으면(빈 본문) `null` 이고, 이때 호출부는 아무 일도 하지 않는다.
 */
export function cutLine(value: string, caret: number): LineCut | null {
  if (!value) return null;
  const pos = Math.max(0, Math.min(caret, value.length));
  const nl = value.indexOf("\n", pos);
  const to = nl < 0 ? value.length : nl + 1;
  let from = pos === 0 ? 0 : value.lastIndexOf("\n", pos - 1) + 1;
  if (nl < 0 && from > 0) from -= 1;
  return {
    from,
    to,
    text: value.slice(from, to),
    next: value.slice(0, from) + value.slice(to),
  };
}
