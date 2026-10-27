/**
 * 코드 블록 카드의 높이. 단계(1x · 2x · full)를 바꾸면 `max-height` 가 흘러가야 하므로, 잘리지 않는
 * 블록도 "상한 없음" 이 아니라 **내용 높이**를 숫자로 둔다 — 숫자에서 `none` 으로는 움직일 수 없다.
 */

export interface CodeBox {
  /** 블록의 줄 수. */
  count: number;
  /** 지금 단계에서 보이는 줄 수. */
  limit: number;
  /** `<pre>` 의 위아래 여백(px). */
  pad: number;
  /** 한 줄의 높이(px). */
  lh: number;
  /** 가로 스크롤바가 먹는 높이(px). */
  bar: number;
}

export function codeClip(b: CodeBox): { clipped: boolean; hidden: number; maxHeight: number } {
  const clipped = b.count > b.limit;
  return {
    clipped,
    hidden: clipped ? b.count - b.limit : 0,
    // 잘릴 때는 아래쪽 여백을 넣지 않는다 — 그 자리에 다음 줄의 머리가 비친다. 안 잘릴 때의 2px 는
    // 반올림 틈이다: 내용과 꼭 같은 상한은 1px 모자라 세로 스크롤바가 생길 수 있다.
    maxHeight: clipped ? b.pad + b.limit * b.lh + b.bar : b.pad * 2 + b.count * b.lh + b.bar + 2,
  };
}
