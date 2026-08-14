/**
 * 1초 롱프레스로 시작하는 드래그.
 *
 * 탐색기의 파일 옮기기와 업무 리스트의 순서 바꾸기가 같은 손동작을 쓴다 — 규칙이 하나면
 * 사용자가 외울 것도 하나다. HTML5 드래그를 쓰지 않는 이유는 탐색기 쪽에 적혀 있다:
 * "1초 누르고 있어야 시작한다" 를 native drag 로는 표현할 수 없고, Tauri 에는 웹뷰 밖으로
 * 파일을 넘기는 API 가 없어 창 밖 드롭은 어차피 좌표로 판정해야 한다.
 */
import { useCallback, useEffect, useRef } from "react";

/** 이만큼 누르고 있어야 드래그가 시작된다 — 그 전에는 평범한 클릭이다. */
export const LONG_PRESS_MS = 1000;
/** 누른 채 이 이상 움직이면 옮길 뜻이 아니라 스크롤·드래그선택으로 본다. */
export const SLOP_PX = 5;

export interface PressStart {
  /** 누르기 시작한 좌표. 타이머가 터질 때 이벤트는 이미 사라지고 없다. */
  x: number;
  y: number;
}

/**
 * 롱프레스 감시기. 돌려주는 `startPress` 를 행의 `onPointerDown` 에 건다.
 *
 * 감시는 행이 아니라 **window** 에 건다. 행에만 걸면 누른 채 이웃 행으로 넘어갔을 때
 * 이벤트가 끊겨서, 옮길 뜻이 없었는데도 1초 뒤에 드래그가 시작된다.
 */
export function useLongPress<T>(onStart: (payload: T, at: PressStart) => void) {
  const press = useRef<{ timer: number; detach: () => void } | null>(null);
  // 타이머 안에서 최신 콜백을 쓴다 — 매 렌더 새로 만들어지는 클로저를 붙잡고 있으면
  // 1초 뒤에 낡은 상태로 드래그가 시작된다.
  const cb = useRef(onStart);
  cb.current = onStart;

  const cancelPress = useCallback(() => {
    if (press.current) {
      window.clearTimeout(press.current.timer);
      press.current.detach();
      press.current = null;
    }
  }, []);

  // 누르고 있는 채로 화면이 바뀌면 타이머만 남는다.
  useEffect(() => cancelPress, [cancelPress]);

  const startPress = useCallback(
    (e: React.PointerEvent, payload: T) => {
      if (e.button !== 0) return;
      // 타이머 안에서 쓸 값은 지금 꺼내 둔다 — 그때는 이벤트의 currentTarget 이 비어 있다.
      const target = e.currentTarget as HTMLElement;
      const pointerId = e.pointerId;
      const { clientX: x, clientY: y } = e;
      cancelPress();

      const onMove = (ev: PointerEvent) => {
        if (Math.abs(ev.clientX - x) > SLOP_PX || Math.abs(ev.clientY - y) > SLOP_PX) cancelPress();
      };
      const detach = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", cancelPress);
        window.removeEventListener("pointercancel", cancelPress);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", cancelPress);
      window.addEventListener("pointercancel", cancelPress);

      press.current = {
        detach,
        timer: window.setTimeout(() => {
          detach();
          press.current = null;
          // 포인터를 잡아 둬야 커서가 행 밖으로 나가도 move/up 이 계속 온다.
          try {
            target.setPointerCapture(pointerId);
          } catch {
            /* 캡처는 최적화일 뿐 — 실패해도 window 리스너로 따라간다 */
          }
          cb.current(payload, { x, y });
        }, LONG_PRESS_MS),
      };
    },
    [cancelPress],
  );

  return { startPress, cancelPress };
}

/**
 * 드롭 직후에 오는 `click` 한 번을 삼킨다.
 *
 * pointerup 뒤에는 click 이 따라오는데, 그걸 선택이나 폴더 접기로 받으면 방금 옮긴 행이
 * 엉뚱하게 반응한다.
 */
export function useDropGuard() {
  const at = useRef(0);
  return {
    markDropped: () => {
      at.current = Date.now();
    },
    justDropped: () => Date.now() - at.current < 300,
  };
}
