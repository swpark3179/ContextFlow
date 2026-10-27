/**
 * 탐색기 드래그 중에 마우스 커서에 붙는 배지.
 *
 * 창 밖에는 우리가 그릴 수 있는 것이 없다 — 고스트는 웹뷰 안에만 존재하고, Tauri 에는
 * 웹뷰 밖으로 파일을 넘기는 API 가 없다. 남는 것이 커서다: 버튼을 누르고 있는 동안은
 * OS 가 포인터를 이 창에 붙잡아 두므로(그래서 포인터 캡처만으로 창 밖 좌표를 계속 받는다)
 * CSS 커서도 바탕화면 위까지 그대로 따라간다.
 *
 * 이미지가 막히는 환경을 위해 표준 키워드를 폴백으로 남긴다 — `copy` 는 ＋ 배지,
 * `alias` 는 바로가기 화살표, `not-allowed` 는 금지 표시로 OS 가 같은 뜻을 그린다.
 */

/**
 * `move` = 업무 폴더 안에서 옮기기, `copy` = 바탕화면으로 복사, `link` = 링크만,
 * `none` = 여기엔 놓을 수 없음(고스트의 "여기엔 놓을 수 없음" 과 같은 때).
 */
export type DragKind = "move" | "copy" | "link" | "none";

/** 표준 화살표. 끝점이 (3,2) 라 핫스팟도 거기다. */
const ARROW =
  '<path d="M3 2 L3 21.5 L8.2 16.6 L11.4 23.4 L14.4 22.1 L11.3 15.4 L17.8 15.1 Z"' +
  ' fill="#fff" stroke="#23211e" stroke-width="1.3" stroke-linejoin="round"/>';

/** 화살표 오른쪽 아래에 얹는 배지 — 흰 카드 안의 기호 하나. 색은 고스트(`ghostLook`)와 같다. */
const BADGE: Record<DragKind, { color: string; glyph: string }> = {
  // 파란 화살표 = 여기로 옮긴다.
  move: { color: "#3a6fd8", glyph: '<path d="M20 24 H27.6"/><path d="M25 21.2 L28 24 L25 26.8"/>' },
  // 초록 ＋ = 원본을 두고 하나 더 만든다 (OS 의 copy 커서와 같은 어휘).
  copy: { color: "#2f7f57", glyph: '<path d="M24 20.2 V27.8"/><path d="M20.2 24 H27.8"/>' },
  // 청록 ↗ = 실체가 아니라 가리키는 링크만. 보라는 AI 전용이라 쓰지 않는다.
  link: { color: "#2f6f80", glyph: '<path d="M20.4 27.6 L27.6 20.4"/><path d="M22.6 20.4 H27.6 V25.4"/>' },
  // 회색 ⦸ = 놓아도 아무 일도 없다.
  none: { color: "#8a857c", glyph: '<circle cx="24" cy="24" r="3.8"/><path d="M21.4 26.6 L26.6 21.4"/>' },
};

function svg(kind: DragKind): string {
  const b = BADGE[kind];
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    ARROW +
    `<rect x="17" y="17" width="14" height="14" rx="3.5" fill="#fff" stroke="${b.color}" stroke-width="1.3"/>` +
    `<g fill="none" stroke="${b.color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">` +
    b.glyph +
    "</g></svg>"
  );
}

const FALLBACK: Record<DragKind, string> = {
  move: "grabbing",
  copy: "copy",
  link: "alias",
  none: "not-allowed",
};

/**
 * `cursor` 속성에 그대로 넣을 값. data URI 는 `#`(색상) 과 `<>` 가 들어가므로 반드시
 * 인코딩해야 하고, 그래야 따옴표도 값 안에 남지 않는다.
 */
export function dragCursor(kind: DragKind): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg(kind))}") 3 2, ${FALLBACK[kind]}`;
}

/**
 * 지금 드래그 상태가 어떤 배지를 뜻하는지. 창 밖에서만 복사/링크로 갈리고, 창 안에서 놓을 수
 * 없는 자리(`blocked`)면 금지 배지다.
 */
export function dragKind(outside: boolean, alt: boolean, blocked = false): DragKind {
  if (outside) return alt ? "link" : "copy";
  return blocked ? "none" : "move";
}
