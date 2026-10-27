import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { EASE_IN, EASE_OUT, reducedMotion } from "../lib/ui";
import { withLeaving, type Kept } from "../lib/leaving";

/**
 * 대화상자들이 함께 쓰는 움직임 조각 — 단계 넘기기 · 다시 재생 · Esc 지키기 · 나가는 줄.
 *
 * 시간과 곡선은 모션 시스템(`global.css` 의 `--m-*` · `--e-*`) 그대로다. JS 로 돌리는 것은 동작 줄이기
 * (`reducedMotion`)를 보고 건너뛴다.
 */

/** 단계 넘기기의 거리(디자인 Iwms 보드). */
const SHIFT = 32;

/**
 * 단계가 앞으로 갔는지(+1) 뒤로 갔는지(-1) — 렌더 중에 셈해 두고, 나가는 칸이 사라지는 순간(정리 함수)에
 * 읽는다. `initial` 은 처음 그릴 때의 방향이다(다른 대화상자에서 넘어온 경우).
 */
export function useStepDir(step: number, initial = 0): { current: number } {
  const last = useRef(step);
  const dir = useRef(initial);
  if (last.current !== step) {
    dir.current = Math.sign(step - last.current);
    last.current = step;
  }
  return dir;
}

/**
 * 단계 칸 — 새 칸은 가는 쪽에서 밀려 들어오고(280ms), 옛 칸은 잔상이 되어 반대쪽으로 빠지며 흐려진다.
 * 그래서 두 칸이 잠깐 겹쳐 지나간다(크로스페이드). 부르는 쪽이 `key` 로 칸을 갈아 끼운다.
 *
 * 부모는 `position: relative` · `overflow: hidden` 이어야 한다 — 잔상이 그 안에 붙는다. 방향이 0 이면
 * 아무것도 움직이지 않는다(처음 열림). 대화상자째 닫힐 때는 부모도 사라지므로 잔상을 남기지 않는다.
 */
export function SlidePane({
  dir,
  style,
  children,
}: {
  dir: { current: number };
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const d = dir.current;
    if (!el || !d || typeof el.animate !== "function") return;
    if (reducedMotion()) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "linear" });
      return;
    }
    el.animate(
      [
        { opacity: 0, transform: `translateX(${d * SHIFT}px)` },
        { opacity: 1, transform: "none" },
      ],
      { duration: 280, easing: EASE_OUT },
    );
    // 들어올 때 한 번만.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const node = ref;
    return () => {
      const el = node.current;
      const parent = el?.parentElement;
      const d = dir.current;
      if (!el || !parent || !d || reducedMotion() || typeof el.animate !== "function") return;
      const r = el.getBoundingClientRect();
      const pr = parent.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const ghost = el.cloneNode(true) as HTMLElement;
      const top = el.scrollTop;
      queueMicrotask(() => {
        // 아직 붙어 있으면 실제로 사라진 것이 아니다(StrictMode). 부모째 사라졌으면 대화상자가 닫힌 것이다.
        if (el.isConnected || !parent.isConnected) return;
        ghost.setAttribute("aria-hidden", "true");
        ghost.removeAttribute("id");
        Object.assign(ghost.style, {
          position: "absolute",
          left: `${r.left - pr.left - parent.clientLeft}px`,
          top: `${r.top - pr.top - parent.clientTop}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
          margin: "0",
          pointerEvents: "none",
          zIndex: "2",
        });
        parent.appendChild(ghost);
        ghost.scrollTop = top;
        ghost.animate(
          [
            { opacity: 1, transform: "none" },
            { opacity: 0, transform: `translateX(${-d * SHIFT}px)` },
          ],
          { duration: 200, easing: EASE_IN, fill: "forwards" },
        );
        window.setTimeout(() => ghost.remove(), 230);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={ref} style={style}>
      {children}
    </div>
  );
}

/**
 * `seq` 가 바뀔 때마다 그 클래스의 애니메이션을 처음부터 다시 돌린다 — 요소를 다시 만들지 않으므로 값 ·
 * 포커스가 그대로다. 그 요소에는 React 의 `className` 을 주지 않는다(덮어쓰인다).
 */
export function useReplay(ref: RefObject<HTMLElement | null>, seq: number, cls: string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !seq) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }, [ref, seq, cls]);
}

/** 첫 Esc 가 경고로 남아 있는 시간 — 이 안에 한 번 더 누르면 닫힌다. */
export const ESC_ARM_MS = 2400;

/**
 * 쓰던 것이 있는 대화상자의 Esc — 첫 번째는 경고만 하고(`armed`), 그 뒤 `ESC_ARM_MS` 안의 두 번째는
 * 그대로 흘려 App 의 Esc 가 닫게 한다.
 *
 * App 의 Esc 체인은 `window` 의 버블 단계에 있고 `defaultPrevented` 면 건너뛴다. 막는 자리는 `document` 의
 * 버블 단계다 — React 의 핸들러(루트에 붙는다)보다 늦고 App 보다 이르다. 그래서 대화상자 안의 고르는 목록
 * (`CategoryPicker`) · 한글 조합이 먼저 Esc 를 쓰면(`defaultPrevented` · `isComposing`) 건드리지 않는다.
 * `window` 의 캡처 단계에서 막으면 그 목록이 접히기도 전에 경고가 뜬다.
 *
 * 포커스가 이 대화상자 밖(위에 뜬 다른 대화상자)에 있으면 그쪽의 Esc 다 — `root` 안이거나 `body` 일 때만 본다.
 */
export function useEscGuard(
  root: RefObject<HTMLElement | null>,
  dirty: boolean,
): { armed: boolean; disarm: () => void } {
  const [armed, setArmed] = useState(false);
  const live = useRef(armed);
  live.current = armed;

  useEffect(() => {
    if (!dirty) {
      setArmed(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      const box = root.current;
      const t = e.target instanceof Node ? e.target : null;
      if (!box || (t && t !== document.body && !box.contains(t))) return;
      if (live.current) {
        // 두 번째 — App 이 닫는다.
        setArmed(false);
        return;
      }
      e.preventDefault();
      setArmed(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dirty, root]);

  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), ESC_ARM_MS);
    return () => window.clearTimeout(t);
  }, [armed]);

  return { armed, disarm: () => setArmed(false) };
}

/**
 * 목록에서 빠진 줄을 `ms` 동안 옛 자리에 남긴다(`withLeaving`) — 부르는 쪽이 그 줄을 `Collapse` 로 접는다.
 * `animate` 가 거짓인 변화(다른 카테고리로 옮겨 가기 · 검색)는 목록째 바뀐 것이라 곧바로 갈아 끼운다.
 * `items` 는 바뀔 때만 새 배열이어야 한다(`useMemo`).
 */
export function useLeaving<T>(items: T[], key: (t: T) => string, animate: boolean, ms = 200): Kept<T>[] {
  const [prev, setPrev] = useState(items);
  const [view, setView] = useState<Kept<T>[]>(() => items.map((item) => ({ item, leaving: false })));
  let out = view;
  if (prev !== items) {
    // 지난 렌더의 정보로 상태를 고치는 React 의 방식 — 이번 렌더에서 곧바로 새 값을 쓴다.
    out = animate
      ? withLeaving(
          view.map((v) => v.item),
          items,
          key,
        )
      : items.map((item) => ({ item, leaving: false }));
    setPrev(items);
    setView(out);
  }
  const leaving = out.some((v) => v.leaving);
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setView((v) => v.filter((x) => !x.leaving)), ms + 20);
    return () => window.clearTimeout(t);
  }, [leaving, view, ms]);
  return out;
}
