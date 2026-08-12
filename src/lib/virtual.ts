/**
 * 가변 높이 가상 스크롤.
 *
 * 보관함의 카드는 태그 줄바꿈과 전문 검색 스니펫 때문에 높이가 제각각이라, 고정 높이
 * 가상화로는 자리를 못 잡는다. 그래서 **추정값으로 먼저 배치하고, 실제로 그려진 행만
 * 재어서 덮어쓰는** 방식을 쓴다. 아직 안 그려 본 행은 계속 추정값을 쓰므로 전체 높이는
 * 스크롤하는 동안 조금씩 정확해진다.
 *
 * 계산부는 훅 밖의 순수 함수로 빼 두었다 — `tree.ts` 와 같은 이유로, 이쪽이 테스트하기
 * 쉽고 렌더 경로와 분리되기 때문이다.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** 각 행의 시작 y 좌표. 길이는 `count + 1` 이고 마지막 값이 전체 높이다. */
export function prefixOffsets(count: number, heightAt: (i: number) => number): number[] {
  const out = new Array<number>(count + 1);
  out[0] = 0;
  for (let i = 0; i < count; i++) out[i + 1] = out[i] + Math.max(0, heightAt(i));
  return out;
}

/**
 * 화면에 걸치는 행의 반열린 구간 `[start, end)`. `overscan` 만큼 위아래로 더 그린다 —
 * 스크롤할 때 빈 칸이 잠깐 보이는 것을 막는다.
 */
export function rangeFor(
  offsets: number[],
  scrollTop: number,
  viewport: number,
  overscan: number,
): [number, number] {
  const count = offsets.length - 1;
  if (count <= 0) return [0, 0];

  const top = Math.max(0, scrollTop);
  // 아래쪽 끝이 화면 위쪽 경계를 넘어서는 첫 행.
  let lo = 0;
  let hi = count - 1;
  let start = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] > top) {
      start = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  const limit = top + Math.max(0, viewport);
  let end = start;
  while (end < count && offsets[end] < limit) end++;

  return [Math.max(0, start - overscan), Math.min(count, end + overscan)];
}

export interface Virtual {
  /** 스크롤 컨테이너에 달 ref. */
  scrollRef: (el: HTMLDivElement | null) => void;
  /** 안쪽 스페이서의 높이. */
  total: number;
  start: number;
  end: number;
  /** `start`..`end` 사이 행의 절대 y 좌표. */
  offsetOf: (i: number) => number;
  /** 각 행에 달 ref — 그려진 실제 높이를 재어 다음 배치에 반영한다. */
  measure: (i: number) => (el: HTMLElement | null) => void;
}

export function useVirtual({
  count,
  estimate,
  overscan = 6,
  resetKey,
}: {
  count: number;
  /** 아직 재어 보지 않은 행의 예상 높이. */
  estimate: (i: number) => number;
  overscan?: number;
  /** 이 값이 바뀌면 측정치를 버린다 — 목록이 바뀌면 인덱스가 다른 항목을 가리킨다. */
  resetKey?: unknown;
}): Virtual {
  const sizes = useRef<number[]>([]);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [, bump] = useState(0);

  useEffect(() => {
    if (!sizes.current.length) return;
    sizes.current = [];
    bump((n) => n + 1);
  }, [resetKey]);

  const detach = useRef<(() => void) | null>(null);
  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    // 콜백 ref 는 노드가 바뀌거나 사라질 때 null 로 한 번 더 불린다 — 여기서 정리한다.
    detach.current?.();
    detach.current = null;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setViewport(el.clientHeight);
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    // 폭이 바뀌면 줄바꿈이 달라져 재어 둔 높이가 전부 무의미해진다.
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      setViewport(el.clientHeight);
      if (el.clientWidth !== lastWidth) {
        lastWidth = el.clientWidth;
        sizes.current = [];
        bump((n) => n + 1);
      }
    });
    ro.observe(el);
    detach.current = () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  const measure = useCallback(
    (i: number) => (el: HTMLElement | null) => {
      if (!el) return;
      const h = el.getBoundingClientRect().height;
      if (h > 0 && Math.abs((sizes.current[i] ?? -1) - h) > 0.5) {
        sizes.current[i] = h;
        bump((n) => n + 1);
      }
    },
    [],
  );

  const offsets = prefixOffsets(count, (i) => sizes.current[i] ?? estimate(i));
  const [start, end] = rangeFor(offsets, scrollTop, viewport, overscan);

  return {
    scrollRef,
    total: offsets[count] ?? 0,
    start,
    end,
    offsetOf: (i) => offsets[i] ?? 0,
    measure,
  };
}
