/**
 * The design expresses interaction states as `style-hover` / `style-focus`
 * attributes on inline-styled elements. These wrappers are the React equivalent
 * so the ported markup keeps its styles inline and readable next to the source.
 */
import {
  forwardRef,
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { AI, type AiSignalKind } from "./design";

type BoxProps = HTMLAttributes<HTMLDivElement> & {
  style?: CSSProperties;
  hover?: CSSProperties;
};

export const Box = forwardRef<HTMLDivElement, BoxProps>(function Box(
  { style, hover, onMouseEnter, onMouseLeave, ...rest },
  ref,
) {
  const [on, setOn] = useState(false);
  return (
    <div
      ref={ref}
      {...rest}
      style={on && hover ? { ...style, ...hover } : style}
      onMouseEnter={(e) => {
        if (hover) setOn(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        if (hover) setOn(false);
        onMouseLeave?.(e);
      }}
    />
  );
});

type SpanProps = HTMLAttributes<HTMLSpanElement> & {
  style?: CSSProperties;
  hover?: CSSProperties;
};

export function Span({ style, hover, onMouseEnter, onMouseLeave, ...rest }: SpanProps) {
  const [on, setOn] = useState(false);
  return (
    <span
      {...rest}
      style={on && hover ? { ...style, ...hover } : style}
      onMouseEnter={(e) => {
        if (hover) setOn(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        if (hover) setOn(false);
        onMouseLeave?.(e);
      }}
    />
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  style?: CSSProperties;
  focusStyle?: CSSProperties;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { style, focusStyle, onFocus, onBlur, ...rest },
  ref,
) {
  const [on, setOn] = useState(false);
  return (
    <input
      ref={ref}
      {...rest}
      style={on && focusStyle ? { ...style, ...focusStyle } : style}
      onFocus={(e) => {
        setOn(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setOn(false);
        onBlur?.(e);
      }}
    />
  );
});

type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  style?: CSSProperties;
  focusStyle?: CSSProperties;
};

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { style, focusStyle, onFocus, onBlur, ...rest },
  ref,
) {
  const [on, setOn] = useState(false);
  return (
    <textarea
      ref={ref}
      {...rest}
      style={on && focusStyle ? { ...style, ...focusStyle } : style}
      onFocus={(e) => {
        setOn(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setOn(false);
        onBlur?.(e);
      }}
    />
  );
});

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} />;
}

// ---------------------------------------------------------------------------
// AI 작업 표시 — 신호 점 · 흐르는 라벨 · 진행선 · 경과 시간 · 스켈레톤 · 커서.
//
// AI 를 기다리는 자리마다 모양이 제각각이고 대부분 멈춰 있어서, 일하는 중인지 멈춘 것인지
// 구분되지 않았다. 여기 여섯 요소로 통일한다. 움직임은 `global.css` 의 `cf-*` 클래스가
// 맡고, 동작 줄이기(`prefers-reduced-motion`)도 거기서 한 번에 접는다.

/**
 * 고른 모양은 모듈에 하나 둔다. 신호 점은 앱 곳곳의 작은 조각이라 스토어를 끌어오지 않고,
 * 설정이 바뀌면 `App` 이 여기에 알린다(`setAiSignalKind`).
 */
let signalKind: AiSignalKind = "pulse";
const signalSubs = new Set<() => void>();

export function setAiSignalKind(kind: AiSignalKind): void {
  if (kind === signalKind) return;
  signalKind = kind;
  signalSubs.forEach((f) => f());
}

function useAiSignalKind(): AiSignalKind {
  return useSyncExternalStore(
    (f) => {
      signalSubs.add(f);
      return () => signalSubs.delete(f);
    },
    () => signalKind,
  );
}

/**
 * ① 신호 점 — 모든 AI 대기의 공통 표시. 기본은 숨쉬는 점 + 퍼지는 링이고, 설정에서 세 점 ·
 * 궤도로 바꿀 수 있다(`kind` 를 주면 그 모양으로 고정 — 설정 화면의 미리보기). `color` 를
 * 흰색으로 주면 진한 단추 위에 쓴다.
 */
export function AiSignal({
  size = 7,
  color = AI.dot,
  kind,
}: {
  size?: number;
  color?: string;
  kind?: AiSignalKind;
}) {
  const chosen = useAiSignalKind();
  const k = kind ?? chosen;
  if (k === "dots") {
    const d = Math.max(4, Math.round(size * 0.62));
    return (
      <span
        aria-hidden
        style={{ display: "inline-flex", alignItems: "center", gap: Math.max(2, Math.round(d * 0.5)), height: size + 4 }}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="cf-dot"
            style={{ width: d, height: d, borderRadius: "50%", background: color, animationDelay: `${i * 0.16}s` }}
          />
        ))}
      </span>
    );
  }
  if (k === "orbit") {
    const o = Math.round(size * 1.7);
    return (
      <span
        aria-hidden
        className="cf-orbit"
        style={{
          position: "relative",
          display: "inline-block",
          width: o,
          height: o,
          flex: `0 0 ${o}px`,
          borderRadius: "50%",
          border: `1.5px solid ${color === "#fff" ? "rgba(255,255,255,.35)" : "#e4dcf8"}`,
          boxSizing: "border-box",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: -3,
            left: "50%",
            marginLeft: -2.5,
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: color,
          }}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      style={{ position: "relative", display: "inline-block", width: size, height: size, flex: `0 0 ${size}px` }}
    >
      <span
        className="cf-ring"
        style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `1.5px solid ${color}` }}
      />
      <span className="cf-pulse" style={{ position: "absolute", inset: 0, borderRadius: "50%", background: color }} />
    </span>
  );
}

/**
 * 움직임 줄이기 — `system` 이면 OS 설정(`prefers-reduced-motion`)을 따르고, `reduce` 면 늘
 * 줄인다. 루트의 `data-motion` 으로 `global.css` 가 같은 규칙을 건다.
 */
export function applyMotion(mode: "system" | "reduce"): void {
  if (mode === "reduce") document.documentElement.dataset.motion = "reduce";
  else delete document.documentElement.dataset.motion;
}

/**
 * ② 흐르는 라벨 — 지금 단계 글자 위로 빛이 지나간다. `tone="ink"` 는 AI 가 아닌 대기
 * (파일 읽기 등)에 — 같은 모양을 회색으로 쓴다.
 */
export function AiStep({ children, tone = "ai" }: { children: ReactNode; tone?: "ai" | "ink" }) {
  const base = tone === "ink" ? "#4e4a43" : AI.fg;
  return (
    <span
      className="cf-shim"
      style={{
        color: "transparent",
        backgroundImage: `linear-gradient(90deg, ${base} 0%, ${base} 38%, ${AI.hi} 50%, ${base} 62%, ${base} 100%)`,
        backgroundSize: "250% 100%",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
      }}
    >
      {children}
    </span>
  );
}

/**
 * ③ 진행선 — 패널 · 모달 머리 바로 아래 2px. `pct`(0–1)를 모르면 흐르는 띠, 알면 채움.
 * 시선이 다른 곳에 있어도 주변 시야에 걸린다.
 */
export function AiRail({ pct }: { pct?: number | null }) {
  const known = pct !== undefined && pct !== null;
  return (
    <span style={{ position: "relative", display: "block", height: 2, background: AI.track, overflow: "hidden" }}>
      {known ? (
        <span
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: `${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%`,
            background: AI.dot,
            transition: "width .3s ease-out",
          }}
        />
      ) : (
        <span
          className="cf-rail"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            background: "linear-gradient(90deg, rgba(106,84,198,0), #6a54c6 50%, rgba(106,84,198,0))",
          }}
        />
      )}
    </span>
  );
}

/** ⑤ 스켈레톤 — AI 가 채울 칸만. 사람이 이미 아는 것(제목)은 그대로 둔다. */
export function Skeleton({ width = "100%", height = 10 }: { width?: number | string; height?: number }) {
  return (
    <span
      aria-hidden
      className="cf-skel"
      style={{
        display: "block",
        width,
        height,
        borderRadius: 3,
        backgroundImage: "linear-gradient(90deg, #efebe4 0%, #efebe4 35%, #f6f2fe 50%, #efebe4 65%, #efebe4 100%)",
        backgroundSize: "200% 100%",
      }}
    />
  );
}

/** ⑥ 커서 — 받는 동안 글 끝에. 끝나면 빼고 완료 줄(걸린 시간)을 둔다. */
export function Caret() {
  return (
    <span
      aria-hidden
      className="cf-caret"
      style={{
        display: "inline-block",
        width: 2,
        height: "1.05em",
        background: AI.dot,
        verticalAlign: "-0.18em",
        marginLeft: 2,
        borderRadius: 1,
      }}
    />
  );
}

/** 이 시각부터 지난 밀리초. 1초마다 다시 그린다. `null` 이면 멈춰 0. */
export function useElapsed(since: number | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const iv = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(iv);
  }, [since]);
  return since ? Math.max(0, now - since) : 0;
}

/** 경과 시간 한 토막 — 정수 초(`12초`) 또는 소수 한 자리(`6.2초`), 1분이 넘으면 `1분 4초`. */
export function fmtSec(ms: number, precise = false): string {
  const s = ms / 1000;
  if (s >= 60) return `${Math.floor(s / 60)}분 ${Math.floor(s % 60)}초`;
  return precise ? `${s.toFixed(1)}초` : `${Math.floor(s)}초`;
}

/** ④ 경과 시간을 보이기 시작하는 시점. 그 전에는 점과 라벨만으로 충분하다. */
export const ELAPSED_AFTER_MS = 3_000;

/**
 * 바쁜 단추의 안쪽 — 신호 점 + 글자 + (3초가 넘으면) 경과 시간. 단추 자체는 각 화면의
 * 것을 그대로 두고 안쪽만 바꾼다. 폭이 흔들리지 않도록 단추 쪽에 `minWidth` 를 준다.
 *
 * AI 작업은 보라 점(`ai`), 아닌 작업은 단추 글자색 점. 진한 바탕 단추면 `color="#fff"`.
 */
export function BusyLabel({
  busy,
  since,
  ai = false,
  color,
  children,
  idle,
}: {
  busy: boolean;
  /** 시작 시각. 주면 3초 뒤부터 경과 시간을 붙인다. */
  since?: number | null;
  ai?: boolean;
  color?: string;
  /** 바쁘지 않을 때의 글자. */
  idle: ReactNode;
  /** 바쁠 때의 글자(‘…’ 없이). */
  children: ReactNode;
}) {
  const ms = useElapsed(busy ? since : null);
  if (!busy) return <>{idle}</>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, width: "100%", whiteSpace: "nowrap" }}>
      <AiSignal size={6} color={color ?? (ai ? AI.dot : "currentColor")} />
      <span>{children}</span>
      {since && ms >= ELAPSED_AFTER_MS && (
        <span
          style={{
            marginLeft: "auto",
            fontFamily: "'Roboto Mono',monospace",
            fontWeight: 500,
            fontSize: 11.5,
            opacity: 0.85,
          }}
        >
          {fmtSec(ms)}
        </span>
      )}
    </span>
  );
}
