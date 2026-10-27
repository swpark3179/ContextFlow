import { useEffect, useRef, useState } from "react";
import { Box, EASE_OUT, Spinner } from "../lib/ui";
import { TEXT } from "../lib/design";
import type { Price } from "../lib/iwms/types";
import { useReplay } from "../modals/motion";

/** 칸 폭은 고정이다 — 고른 칸 밑의 바탕이 그 폭째 미끄러진다. */
const OPTIONS: { value: Price | null; label: string; w: number; title: string; fg: string; bg: string }[] = [
  { value: null, label: "–", w: 22, title: "i-WMS 에 입력하지 않습니다", fg: "#6a665e", bg: "#ece8e0" },
  { value: "O", label: "포함", w: 36, title: "대가포함(운영) 업무로 i-WMS 에 입력합니다", fg: "#2f5cbb", bg: "#e6eefc" },
  { value: "N", label: "미포함", w: 46, title: "대가미포함(비대상) 업무로 i-WMS 에 입력합니다", fg: "#4e4a43", bg: "#f0ede7" },
];

/**
 * 오늘의 한일 한 줄의 대가 구분 — `[– | 포함 | 미포함]`.
 *
 * 누르면 곧바로 옮겨 간다(낙관적). 기록하는 동안 오른쪽에 작은 돌기가 돌고, 실패하면(`onChange` 가 거절)
 * 원래 칸으로 돌아가며 좌우로 흔들린다 — 예전에는 저장이 끝나야 칸이 바뀌어 누른 것이 먹지 않은 것처럼
 * 보였다. 기다리는 동안 바깥 값이 바뀌어도 고른 칸을 지킨다.
 *
 * 줄을 누르면 펼쳐지므로 여기서 누른 것은 줄까지 올라가지 않게 막는다.
 */
export default function IwmsPriceSwitch({
  value,
  onChange,
  label,
}: {
  value: Price | null;
  onChange: (next: Price | null) => Promise<void> | void;
  label?: string;
}) {
  const [shown, setShown] = useState(value);
  const [pending, setPending] = useState(false);
  const [shake, setShake] = useState(0);
  const seq = useRef(0);
  const box = useRef<HTMLDivElement | null>(null);
  useReplay(box, shake, "cf-shake");

  // 바깥 값을 따라간다(다시 읽기 · 실패 뒤 되돌리기). 기다리는 중에는 고른 칸을 지킨다.
  useEffect(() => {
    if (!pending) setShown(value);
  }, [value, pending]);

  const pick = async (next: Price | null) => {
    if (next === shown) return;
    const my = ++seq.current;
    setShown(next);
    setPending(true);
    try {
      await onChange(next);
      if (my === seq.current) setPending(false);
    } catch {
      if (my !== seq.current) return;
      setPending(false);
      setShake((n) => n + 1);
    }
  };

  const at = Math.max(0, OPTIONS.findIndex((o) => o.value === shown));
  const left = OPTIONS.slice(0, at).reduce((n, o) => n + o.w, 0);
  const cur = OPTIONS[at];

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 3 }}
    >
      <div
        ref={box}
        role="radiogroup"
        aria-label={label ?? "대가 구분"}
        aria-busy={pending || undefined}
        style={{
          position: "relative",
          display: "flex",
          border: "1px solid #e0dcd4",
          borderRadius: 4,
          overflow: "hidden",
          height: 18,
          background: "#fff",
        }}
      >
        <span
          aria-hidden
          className="cf-mv"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left,
            width: cur.w,
            background: cur.bg,
            transition: `left 160ms ${EASE_OUT}, width 160ms ${EASE_OUT}, background-color 160ms`,
          }}
        />
        {OPTIONS.map((o, i) => {
          const on = i === at;
          return (
            <Box
              key={o.label}
              role="radio"
              aria-checked={on}
              title={o.title}
              onClick={() => void pick(o.value)}
              style={{
                position: "relative",
                width: o.w,
                flex: `0 0 ${o.w}px`,
                textAlign: "center",
                fontSize: 11,
                lineHeight: "18px",
                cursor: on ? "default" : "pointer",
                color: on ? o.fg : TEXT.sub,
                fontWeight: on ? 600 : 400,
                borderLeft: i ? "1px solid #eeeae3" : "none",
                transition: "color 140ms",
              }}
              hover={on ? undefined : { color: TEXT.ink }}
            >
              {o.label}
            </Box>
          );
        })}
      </div>
      {/* 기록하는 동안 — 자리는 늘 비워 두어 줄이 흔들리지 않는다. */}
      <span aria-hidden style={{ width: 9, height: 9, display: "inline-flex" }}>
        {pending && <Spinner size={9} />}
      </span>
    </div>
  );
}
