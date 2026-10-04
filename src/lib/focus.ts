/**
 * 창에 돌아올 때 디스크를 다시 읽는 문턱(`App` 의 창 포커스 구독 → `refreshFromDisk`).
 *
 * 신호는 OS 창의 포커스다(`onFocusChanged`). DOM 의 focus · visibility 는 쓰지 않는다 — HTML 뷰어의
 * iframe 으로 포커스가 들어가도 흐려진 것으로 보이고, Alt-Tab 으로 창을 오가도 문서는 계속 보인다.
 */

/**
 * 이만큼은 다른 창에 가 있어야 다시 읽는다. 앱이 Obsidian 을 띄우는 순간 창이 잠깐 흐려졌다
 * 돌아오는 깜빡임을 거른다. 파일 대화상자를 닫고 돌아온 뒤의 다시 읽기는 거르지 않는다 — 해가 없다.
 */
export const AWAY_MS = 1000;

/** 다시 읽기 사이의 최소 간격 — 창을 거푸 오가는 동안 Vault 를 매번 훑지 않게. */
export const RELOAD_GAP_MS = 3000;

/** 돌아온 뒤 이만큼 기다렸다 읽는다. 그 사이에 다시 흐려지면 취소한다(`App`). */
export const RELOAD_DELAY_MS = 250;

/**
 * 돌아왔을 때 다시 읽을지. `blurredAt` 은 흐려진 시각(흐려진 적이 없으면 `null`), `lastAt` 은 지난
 * 다시 읽기를 시작한 시각이다 — 건너뛴 다시 읽기는 세지 않는다(`lastReloadAt`).
 */
export function shouldReload(blurredAt: number | null, now: number, lastAt: number): boolean {
  return blurredAt !== null && now - blurredAt >= AWAY_MS && now - lastAt >= RELOAD_GAP_MS;
}
