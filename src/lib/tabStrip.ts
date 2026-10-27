/**
 * 탭 띠의 가로 스크롤 — 넘치면 띠가 옆으로 굴러가고, 활성 탭은 보이는 자리로 들어오고, 넘친 쪽
 * 가장자리는 옅게 사라진다. 잴 값은 그리는 쪽(`EditorPane`)이 넘기고 여기서는 셈만 한다.
 */

/**
 * 활성 탭이 다 보이도록 굴릴 `scrollLeft`. 이미 다 보이면 `null`(굴리지 않는다).
 *
 * `pad` 는 가장자리 페이드의 폭이다 — 탭이 페이드 밑에 걸쳐 있으면 보이는데도 반쯤 지워져 보인다.
 * 보이는 폭보다 넓은 탭은 왼쪽(이름의 시작)을 맞춘다.
 */
export function revealLeft(
  left: number,
  width: number,
  scroll: number,
  view: number,
  pad = 0,
): number | null {
  const a = left - pad;
  const b = left + width + pad;
  if (a < scroll) return Math.max(0, a);
  if (b > scroll + view) return Math.max(0, b - view > a ? a : b - view);
  return null;
}

/** 넘쳐서 가려진 쪽. 1px 는 소수 스크롤 위치의 반올림 틈이다. */
export function edgeFades(
  scroll: number,
  scrollWidth: number,
  clientWidth: number,
): { left: boolean; right: boolean } {
  return { left: scroll > 1, right: scroll + clientWidth < scrollWidth - 1 };
}

/** 가려진 쪽을 옅게 지우는 `mask-image`. 넘치지 않으면 `undefined`(가면 없음). */
export function fadeMask(e: { left: boolean; right: boolean }, px = 18): string | undefined {
  if (!e.left && !e.right) return undefined;
  const l = e.left ? "transparent" : "#000";
  const r = e.right ? "transparent" : "#000";
  return `linear-gradient(to right, ${l} 0, #000 ${px}px, #000 calc(100% - ${px}px), ${r} 100%)`;
}
