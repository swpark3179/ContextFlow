/**
 * The design expresses interaction states as `style-hover` / `style-focus`
 * attributes on inline-styled elements. These wrappers are the React equivalent
 * so the ported markup keeps its styles inline and readable next to the source.
 */
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { AI, TEXT, type AiSignalKind } from "./design";

type BoxProps = HTMLAttributes<HTMLDivElement> & {
  style?: CSSProperties;
  hover?: CSSProperties;
};

/** 호버가 있는 요소는 `cf-hover` 로 색이 90ms 에 바뀐다 — 예전에는 순간 교체였다. */
function hoverClass(hover: CSSProperties | undefined, className: string | undefined): string | undefined {
  if (!hover) return className;
  return className ? `cf-hover ${className}` : "cf-hover";
}

/**
 * 호버가 테두리 색(`borderColor`)만 바꾸는데 바탕이 줄여 쓰기(`border: "1px solid #…"`)면, React 가 다시
 * 그릴 때 둘을 섞었다고 경고하고 떠난 뒤 테두리 색이 지워질 수 있다. 그런 바탕은 풀어 쓴다.
 */
function hoverStyle(style: CSSProperties | undefined, hover: CSSProperties | undefined, on: boolean) {
  let base = style;
  if (hover?.borderColor !== undefined && typeof style?.border === "string") {
    const m = /^(\S+)\s+(\S+)\s+(.+)$/.exec(style.border.trim());
    if (m) {
      const { border: _drop, ...rest } = style;
      base = { ...rest, borderWidth: m[1], borderStyle: m[2] as CSSProperties["borderStyle"], borderColor: m[3] };
    }
  }
  return on && hover ? { ...base, ...hover } : base;
}

export const Box = forwardRef<HTMLDivElement, BoxProps>(function Box(
  { style, hover, onMouseEnter, onMouseLeave, className, ...rest },
  ref,
) {
  const [on, setOn] = useState(false);
  return (
    <div
      ref={ref}
      {...rest}
      className={hoverClass(hover, className)}
      style={hoverStyle(style, hover, on)}
      onMouseEnter={(e) => {
        if (hover) setOn(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        // `hover` 가 사라졌다 다시 생기는 요소(고른 칸 · 켜진 항목)도 떠날 때는 꼭 내린다 — 남으면 호버가 붙어 있다.
        if (on) setOn(false);
        onMouseLeave?.(e);
      }}
    />
  );
});

type SpanProps = HTMLAttributes<HTMLSpanElement> & {
  style?: CSSProperties;
  hover?: CSSProperties;
};

export function Span({ style, hover, onMouseEnter, onMouseLeave, className, ...rest }: SpanProps) {
  const [on, setOn] = useState(false);
  return (
    <span
      {...rest}
      className={hoverClass(hover, className)}
      style={hoverStyle(style, hover, on)}
      onMouseEnter={(e) => {
        if (hover) setOn(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        if (on) setOn(false);
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
  /** 시작 시각. 없으면 바빠진 순간부터 잰다. 3초 뒤부터 경과 시간을 붙인다. */
  since?: number | null;
  ai?: boolean;
  color?: string;
  /** 바쁘지 않을 때의 글자. */
  idle: ReactNode;
  /** 바쁠 때의 글자(‘…’ 없이). */
  children: ReactNode;
}) {
  // 시작 시각을 모르는 단추(스토어의 busy 깃발만 있는 곳)는 바빠진 순간을 스스로 잡는다.
  const [own, setOwn] = useState<number | null>(null);
  useEffect(() => setOwn(busy ? Date.now() : null), [busy]);
  const start = since ?? own;
  const ms = useElapsed(busy ? start : null);
  if (!busy) return <>{idle}</>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, width: "100%", whiteSpace: "nowrap" }}>
      <AiSignal size={6} color={color ?? (ai ? AI.dot : "currentColor")} />
      <span>{children}</span>
      {start && ms >= ELAPSED_AFTER_MS && (
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

/**
 * 기다리는 동안의 안내 띠 — 신호 점 · 흐르는 라벨 · 받은 글자 수(또는 생각 글자 수) · 경과 ·
 * [취소]. 모달 본문 맨 위에 둔다. AI 가 아닌 대기(`ai={false}`, 파일 읽기 등)는 같은 모양을
 * 회색으로 쓴다.
 */
export function AiWaitBar({
  since,
  label,
  ai = true,
  chars,
  thinking,
  onCancel,
  style,
}: {
  since: number | null;
  label: ReactNode;
  ai?: boolean;
  /** 받은 답의 글자 수. 있으면 생각 글자 수보다 앞선다. */
  chars?: number | null;
  /** 받은 생각 토큰의 글자 수 — 답이 오기 전에 추론 모델이 생각하는 동안. */
  thinking?: number | null;
  onCancel?: (() => void) | null;
  style?: CSSProperties;
}) {
  const ms = useElapsed(since);
  const count = chars
    ? `${chars.toLocaleString()}자`
    : thinking
      ? `생각 ${thinking.toLocaleString()}자`
      : null;
  return (
    <div
      role="status"
      style={{
        margin: "9px 14px 2px",
        display: "flex",
        alignItems: "center",
        gap: 9,
        flexWrap: "wrap",
        fontSize: 12.5,
        fontWeight: 500,
        padding: "6px 9px",
        borderRadius: 6,
        background: ai ? AI.soft : "#faf9f6",
        border: `1px solid ${ai ? AI.softBd : "#ece8e0"}`,
        ...style,
      }}
    >
      <span style={{ width: 14, display: "flex", justifyContent: "center" }}>
        <AiSignal color={ai ? AI.dot : "#8a857c"} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <AiStep tone={ai ? "ai" : "ink"}>{label}</AiStep>
      </span>
      {count && (
        <span style={{ flex: "0 0 auto", fontFamily: "'Roboto Mono',monospace", fontSize: 11.5, color: TEXT.body }}>
          {count}
        </span>
      )}
      {since !== null && (
        <span
          style={{
            flex: "0 0 auto",
            fontFamily: "'Roboto Mono',monospace",
            fontSize: 11.5,
            color: ai ? AI.fg : TEXT.sub,
          }}
        >
          {fmtSec(ms)}
        </span>
      )}
      {onCancel && (
        <Box
          onClick={onCancel}
          style={{
            flex: "0 0 auto",
            height: 22,
            display: "inline-flex",
            alignItems: "center",
            padding: "0 8px",
            borderRadius: 4,
            border: "1px solid #ddd8cf",
            background: "#fff",
            fontSize: 11.5,
            fontWeight: 400,
            color: TEXT.ink,
            cursor: "pointer",
          }}
          hover={{ background: "#f2efe9" }}
        >
          취소
        </Box>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 모션 부품 — 디자인 검토(ContextFlow 디자인 개선 · 모션)의 모션 시스템. 시간과 곡선은
// `global.css` 의 토큰(`--m-*` · `--e-*`)과 같은 값이다. CSS 로 그릴 수 없는 움직임(자리 옮기기 ·
// 숫자 · 닫히는 잔상)만 여기서 JS 로 돌리고, 동작 줄이기는 `reducedMotion` 하나로 판단한다.

export const EASE_OUT = "cubic-bezier(.2,.8,.2,1)";
export const EASE_IN = "cubic-bezier(.4,0,1,1)";

/**
 * 지금 움직임을 줄여야 하는가 — 앱 설정(`data-motion="reduce"`, `applyMotion`) 또는 OS 설정.
 * CSS 가 닿지 않는 움직임(자리 옮기기 · 숫자 · 부드러운 스크롤)이 본다.
 */
export function reducedMotion(): boolean {
  if (typeof document === "undefined") return true;
  if (document.documentElement.dataset.motion === "reduce") return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 롱프레스 링 — 누르고 있는 1초(`LONG_PRESS_MS`)가 차오른다. 처음 15% 는 비워 두어 그냥 누른
 * 클릭에서는 보이지 않는다(`cfHold`). 부르는 쪽이 누르는 동안만 그린다. 동작 줄이기에서도 남는다 —
 * 진행 신호다.
 */
export function HoldRing({
  size = 17,
  color = "#3a6fd8",
  track = "#d9d4ca",
  style,
}: {
  size?: number;
  color?: string;
  track?: string;
  style?: CSSProperties;
}) {
  const c = size / 2;
  const r = c - 1.5;
  const len = 2 * Math.PI * r;
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ position: "absolute", pointerEvents: "none", ...style }}
    >
      <circle cx={c} cy={c} r={r} fill="none" stroke={track} strokeWidth={1.6} />
      <circle
        className="cf-hold"
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeDasharray={len}
        strokeDashoffset={len}
        transform={`rotate(-90 ${c} ${c})`}
        style={{ ["--cf-ring" as string]: len } as CSSProperties}
      />
    </svg>
  );
}

/** 작은 돌기 — AI 가 아닌 대기(저장 · 파일 쓰기 · 다시 조회)의 표시. 보라를 쓰지 않는다. */
export function Spinner({
  size = 10,
  color = TEXT.sub,
  track = "#e6e2da",
  style,
}: {
  size?: number;
  color?: string;
  track?: string;
  style?: CSSProperties;
}) {
  return (
    <svg aria-hidden className="cf-orbit" width={size} height={size} viewBox="0 0 10 10" style={{ flex: `0 0 ${size}px`, ...style }}>
      <circle cx="5" cy="5" r="3.6" fill="none" stroke={track} strokeWidth="1.4" />
      <path d="M5 1.4a3.6 3.6 0 0 1 3.6 3.6" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** 확인 체크 — 저장됨 · 완료 · 성공. 나타날 때 한 번 튄다(`cf-pop`). */
export function CheckMark({ size = 10, color = "currentColor", pop = true }: { size?: number; color?: string; pop?: boolean }) {
  return (
    <svg aria-hidden className={pop ? "cf-pop" : undefined} width={size} height={size} viewBox="0 0 10 10" style={{ flex: `0 0 ${size}px` }}>
      <path d="M1.6 5.2 4 7.5 8.5 2.6" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * 높이째 열고 닫는 상자 — 폴더 · 묶음 · 도크 · 펼친 줄. 예전에는 자식이 한 프레임에 생기고 사라져
 * 아래 줄이 통째로 튀었다. 닫힌 동안에는 자식을 그리지 않는다(닫히는 200ms 동안만 남는다).
 */
export function Collapse({
  open,
  children,
  ms = 200,
  style,
}: {
  open: boolean;
  children: ReactNode;
  ms?: number;
  style?: CSSProperties;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [show, setShow] = useState(open);
  const [h, setH] = useState<string>(open ? "auto" : "0px");
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = box.current;
    if (!el) return;
    if (reducedMotion()) {
      setShow(open);
      setH(open ? "auto" : "0px");
      return;
    }
    let t: number | undefined;
    let raf = 0;
    if (open) {
      setShow(true);
      // 자식이 그려진 다음 프레임에 높이를 잰다.
      raf = requestAnimationFrame(() => {
        setH(`${el.scrollHeight}px`);
        t = window.setTimeout(() => setH("auto"), ms);
      });
    } else {
      setH(`${el.scrollHeight}px`);
      raf = requestAnimationFrame(() => {
        setH("0px");
        t = window.setTimeout(() => setShow(false), ms);
      });
    }
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [open, ms]);
  return (
    <div
      ref={box}
      style={{
        height: h,
        overflow: h === "auto" ? undefined : "hidden",
        transition: `height ${ms}ms ${EASE_OUT}`,
        ...style,
      }}
    >
      {show && children}
    </div>
  );
}

/**
 * 목록의 자리 옮기기(FLIP) — `data-flip` 을 단 자식들의 위치를 매번 재 두었다가, `key` 가 바뀐 렌더에서
 * 옛 자리에서 새 자리로 미끄러지게 한다. 순서가 바뀐 업무 · 맨 위로 올라온 오늘의 한일 · 다시 매긴
 * 추천 카드가 쓴다. 위치는 상자 기준이라 스크롤은 움직임으로 세지 않는다. `enter` 면 새로 생긴 자식은
 * 위에서 밀고 들어온다.
 */
export function useFlip(
  ref: RefObject<HTMLElement | null>,
  key: unknown,
  opts: { ms?: number; enter?: boolean } = {},
): void {
  const prev = useRef<Map<string, number> | null>(null);
  const lastKey = useRef<unknown>(key);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const top0 = box.getBoundingClientRect().top - box.scrollTop;
    const nodes = box.querySelectorAll<HTMLElement>("[data-flip]");
    const next = new Map<string, number>();
    nodes.forEach((n) => next.set(n.dataset.flip as string, n.getBoundingClientRect().top - top0));
    const changed = lastKey.current !== key;
    lastKey.current = key;
    const was = prev.current;
    prev.current = next;
    if (!changed || !was || reducedMotion() || typeof Element.prototype.animate !== "function") return;
    const ms = opts.ms ?? 200;
    nodes.forEach((n) => {
      const id = n.dataset.flip as string;
      const from = was.get(id);
      if (from === undefined) {
        if (opts.enter) {
          n.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], {
            duration: ms,
            easing: EASE_OUT,
          });
        }
        return;
      }
      const dy = from - (next.get(id) as number);
      if (Math.abs(dy) < 0.5) return;
      n.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: ms, easing: EASE_OUT });
    });
  });
}

/**
 * 숫자를 옛 값에서 새 값으로 흘린다 — 분 다시 나누기 · 다시 매긴 유사도. 동작 줄이기면 곧바로 새 값.
 * 소수가 나오므로 그리는 쪽이 반올림한다.
 */
export function useTween(value: number, ms = 400): number {
  const [shown, setShown] = useState(value);
  const cur = useRef(value);
  useEffect(() => {
    const a = cur.current;
    const b = value;
    if (a === b) return;
    if (reducedMotion() || !Number.isFinite(a) || !Number.isFinite(b)) {
      cur.current = b;
      setShown(b);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      const v = a + (b - a) * (1 - Math.pow(1 - k, 3));
      cur.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

/**
 * 닫히는 잔상. 대화상자 · 메뉴 · 토스트는 스토어 값이 비는 순간 `null` 을 그려 한 프레임에 사라진다
 * — 닫힘이 순간 절단이다. 사라지기 직전의 DOM 을 복제해 같은 자리에 붙이고 나가는 움직임을 한 번
 * 돌린 뒤 지운다. 복제본은 눌리지 않고(`pointer-events: none`) 화면 읽기에도 잡히지 않는다. 스크롤
 * 위치도 옮겨 실어 닫히는 동안 내용이 튀지 않는다.
 *
 * 붙이는 것은 커밋이 끝난 뒤(마이크로태스크)이고, 그때도 원본이 문서에 붙어 있으면 실제로 사라진 것이
 * 아니므로(StrictMode 의 두 번 도는 effect) 버린다. `enabled` 가 거짓이면 잔상을 남기지 않는다 —
 * 다른 대화상자로 이어지는 닫힘(오늘의 한일 → i-WMS)이 그렇다.
 */
export function useExitSnapshot(
  ref: RefObject<HTMLElement | null>,
  kind: "modal" | "menu" | "toast" = "menu",
  enabled = true,
): void {
  const on = useRef(enabled);
  on.current = enabled;
  useLayoutEffect(() => {
    const node = ref;
    return () => {
      const el = node.current;
      if (!el || !on.current || reducedMotion() || typeof Element.prototype.animate !== "function") return;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const cs = getComputedStyle(el);
      const ghost = el.cloneNode(true) as HTMLElement;
      const scrolls: [number, number, number][] = [];
      el.querySelectorAll<HTMLElement>("*").forEach((n, i) => {
        if (n.scrollTop || n.scrollLeft) scrolls.push([i, n.scrollTop, n.scrollLeft]);
      });
      queueMicrotask(() => {
        if (el.isConnected) return;
        ghost.setAttribute("aria-hidden", "true");
        ghost.removeAttribute("id");
        ghost.style.pointerEvents = "none";
        if (cs.position !== "fixed") {
          Object.assign(ghost.style, {
            position: "fixed",
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            right: "auto",
            bottom: "auto",
            margin: "0",
            transform: "none",
          });
        }
        ghost.style.zIndex = String(Math.max(Number(cs.zIndex) || 0, 60));
        ghost.style.animation = "none";
        document.body.appendChild(ghost);
        const all = ghost.querySelectorAll<HTMLElement>("*");
        for (const [i, top, left] of scrolls) {
          if (all[i]) {
            all[i].scrollTop = top;
            all[i].scrollLeft = left;
          }
        }
        let ms = 100;
        if (kind === "modal") {
          ms = 140;
          ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: "linear", fill: "forwards" });
          const panel = ghost.firstElementChild as HTMLElement | null;
          if (panel) {
            panel.style.animation = "none";
            panel.animate([{ transform: "none" }, { transform: "translateY(6px) scale(.99)" }], {
              duration: ms,
              easing: EASE_IN,
              fill: "forwards",
            });
          }
        } else if (kind === "toast") {
          ms = 140;
          ghost.animate(
            [
              { opacity: 1, transform: "none" },
              { opacity: 0, transform: "translateX(12px)" },
            ],
            { duration: ms, easing: EASE_IN, fill: "forwards" },
          );
        } else {
          ghost.animate(
            [
              { opacity: 1, transform: "none" },
              { opacity: 0, transform: "translateY(-2px) scale(.98)" },
            ],
            { duration: ms, easing: EASE_IN, fill: "forwards" },
          );
        }
        window.setTimeout(() => ghost.remove(), ms + 30);
      });
    };
  }, [ref, kind]);
}

/**
 * 메뉴 · 팝오버 판 — 붙은 자리(`origin`)에서 자라나고(`cf-menu`) 닫힐 때 잔상이 짧게 나간다
 * (`useExitSnapshot`). 바깥을 누르면 닫힌다. `esc` 면 Esc 를 capture 단계에서 먼저 받아
 * `preventDefault()` 한다 — App 의 Esc 사슬이 메뉴 밑의 대화상자까지 닫지 않게. 안에서 Esc 를 스스로
 * 다루는 입력(카테고리 고르기 — 목록 먼저 닫는다)은 `esc={false}` 로 맡긴다.
 */
export function Popover({
  onClose,
  origin = "top left",
  esc = true,
  role = "menu",
  style,
  children,
}: {
  onClose: () => void;
  origin?: string;
  esc?: boolean;
  role?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useExitSnapshot(ref, "menu");
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!esc) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close.current();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [esc]);
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 25 }} />
      <div
        ref={ref}
        role={role}
        className="cf-menu"
        style={{
          position: "absolute",
          zIndex: 30,
          background: "#fff",
          border: "1px solid #d9d4ca",
          borderRadius: 6,
          boxShadow: "0 10px 26px rgba(35,33,30,.16)",
          padding: 4,
          transformOrigin: origin,
          ...style,
        }}
      >
        {children}
      </div>
    </>
  );
}
