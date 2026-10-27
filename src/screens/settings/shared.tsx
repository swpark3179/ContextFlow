/**
 * 설정 화면이 공유하는 껍데기와 위젯.
 *
 * ContextFlow 는 CSS Modules 를 쓰지 않고 전부 인라인 `CSSProperties` 다 — 디자인 HTML 에서
 * 옮겨 온 관례이므로 AI 카드도 같은 방식을 따른다.
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  AiSignal,
  Box,
  BusyLabel,
  CheckMark,
  ELAPSED_AFTER_MS,
  Input,
  Spinner,
  TextArea,
  fmtSec,
  useElapsed,
} from "../../lib/ui";
import { AI, GREEN, TEXT } from "../../lib/design";
import type { DetectedAgent } from "../../lib/ai";
import { DIAGNOSTIC_HINT, MODELS_SOURCE_LABEL } from "../../lib/ai";

export const cardStyle: CSSProperties = {
  border: "1px solid #e6e2da",
  borderRadius: 7,
  background: "#fff",
  overflow: "hidden",
};

export const headStyle: CSSProperties = {
  padding: "8px 12px",
  background: "#f7f5f1",
  borderBottom: "1px solid #e6e2da",
  fontSize: 11.5,
  fontWeight: 600,
  letterSpacing: ".4px",
  color: "#6a665e",
};

export const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 12px",
  borderBottom: "1px solid #f4f1ec",
};

export const inputMono: CSSProperties = {
  height: 28,
  border: "1px solid #ddd8cf",
  borderRadius: 5,
  padding: "0 9px",
  fontFamily: "'Roboto Mono',monospace",
  fontSize: 12,
  outline: "none",
  background: "#fff",
  color: "#23211e",
};

export const inputFocus: CSSProperties = {
  borderColor: "#3a6fd8",
  boxShadow: "0 0 0 2px #e6eefc",
};

/** 설명·경고 한 줄. 카드 전체가 공유한다. */
export const hintStyle: CSSProperties = {
  fontSize: 11.5,
  color: "#6a665e",
  lineHeight: 1.6,
};

const HINT = hintStyle;

export function Chip({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        height: 24,
        padding: "0 10px",
        display: "flex",
        alignItems: "center",
        borderRadius: 4,
        fontSize: 11.5,
        cursor: "pointer",
        whiteSpace: "nowrap",
        border: `1px solid ${on ? "#cddcf8" : "#ddd8cf"}`,
        background: on ? "#eef3fd" : "#fff",
        color: on ? "#2f5cbb" : "#6a665e",
        fontWeight: on ? 600 : 400,
      }}
    >
      {label}
    </div>
  );
}

/**
 * 켜고 끄는 스위치. 손잡이가 자리를 바꾸지 않고 미끄러진다(`cf-mv` — 동작 줄이기면 곧바로). 켠 색은
 * 조작의 파랑이다 — 보라는 "AI 가 지금 일한다" 에만 쓴다.
 */
export function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label?: string }) {
  return (
    <div
      role="switch"
      aria-checked={on}
      aria-label={label}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        position: "relative",
        flex: "0 0 34px",
        width: 34,
        height: 19,
        borderRadius: 11,
        cursor: "pointer",
        background: on ? "#3a6fd8" : "#d5d0c6",
        transition: "background-color 160ms linear",
        outline: "none",
      }}
    >
      <div
        className="cf-mv"
        style={{
          position: "absolute",
          top: 2,
          left: 2,
          width: 15,
          height: 15,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 2px rgba(0,0,0,.2)",
          transform: `translateX(${on ? 15 : 0}px)`,
          transition: "transform 160ms cubic-bezier(.34,1.4,.64,1)",
        }}
      />
    </div>
  );
}

/**
 * AI 가 아닌 대기의 단추 안쪽 — 돌기 + 글자 + (3초가 넘으면) 경과. `BusyLabel` 과 같은 자리를 쓰되
 * 보라 점 대신 회색 돌기다(저장 · 탐지 · 가져오기).
 */
function SpinLabel({ color, children }: { color: string; children: ReactNode }) {
  const [since] = useState(() => Date.now());
  const ms = useElapsed(since);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, width: "100%", whiteSpace: "nowrap" }}>
      <Spinner color={color} />
      <span>{children}</span>
      {ms >= ELAPSED_AFTER_MS && (
        <span style={{ marginLeft: "auto", fontFamily: "'Roboto Mono',monospace", fontSize: 11.5, opacity: 0.85 }}>
          {fmtSec(ms)}
        </span>
      )}
    </span>
  );
}

/** 버튼. `primary` 는 저장처럼 되돌리기 어려운 동작에만. */
/**
 * 설정 카드의 단추. `busy` 면 눌리지 않지만 흐려지지 않고 신호 점 · `busyLabel` · 경과 시간을
 * 보인다(`BusyLabel`) — 흐린 글자 하나로는 멈춘 단추와 갈리지 않았다. AI 를 기다리는 단추는
 * `ai` 로 보라를 쓴다.
 */
export function Btn({
  label,
  onClick,
  primary,
  disabled,
  busy,
  busyLabel,
  ai,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  /** 바쁠 때의 글자(‘…’ 없이). */
  busyLabel?: string;
  ai?: boolean;
}) {
  const off = disabled && !busy;
  const tone = busy && ai
    ? { bd: AI.bd, bg: AI.bg, fg: AI.fg }
    : primary
      ? { bd: "#cddcf8", bg: "#eef3fd", fg: "#2f5cbb" }
      : { bd: "#ddd8cf", bg: "#f7f5f1", fg: "#4e4a43" };
  return (
    <Box
      role={busy ? "status" : undefined}
      onClick={() => {
        if (!disabled && !busy) onClick();
      }}
      style={{
        height: 28,
        minWidth: busy ? 96 : undefined,
        padding: "0 12px",
        display: "flex",
        alignItems: "center",
        border: `1px solid ${tone.bd}`,
        borderRadius: 5,
        background: tone.bg,
        fontSize: 12.5,
        fontWeight: primary || (busy && ai) ? 600 : 400,
        color: off ? "#b5afa2" : tone.fg,
        cursor: busy ? "progress" : off ? "default" : "pointer",
        whiteSpace: "nowrap",
        opacity: off ? 0.6 : 1,
      }}
      hover={off || busy ? undefined : { background: primary ? "#e2ebfb" : "#ece8e0" }}
    >
      {busy && !ai ? (
        <SpinLabel color={tone.fg}>{busyLabel ?? label}</SpinLabel>
      ) : (
        <BusyLabel busy={!!busy} ai={ai} idle={label}>
          {busyLabel ?? label}
        </BusyLabel>
      )}
    </Box>
  );
}

/** 라벨 + 입력 한 줄. */
export function Field({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 5 }}>{label}</div>
      {children}
      {note && <div style={{ ...HINT, marginTop: 5 }}>{note}</div>}
    </div>
  );
}

export function TextField({
  label,
  note,
  value,
  onChange,
  placeholder,
  password,
}: {
  label: string;
  note?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  password?: boolean;
}) {
  return (
    <Field label={label} note={note}>
      <Input
        type={password ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ ...inputMono, width: "100%", boxSizing: "border-box" }}
        focusStyle={inputFocus}
      />
    </Field>
  );
}

/**
 * `모델 직접 지정` textarea — 형식은 한 줄에 `id` 또는 `id | 표시이름`.
 * 파싱은 `parseModelLines`, 되돌리기는 `modelLines` (`src/lib/ai.ts`).
 */
export function CustomModelsField({
  value,
  onChange,
  placeholder,
  note,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  note: string;
}) {
  return (
    <Field label="모델 직접 지정 (선택)" note={note}>
      <TextArea
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          ...inputMono,
          height: "auto",
          width: "100%",
          boxSizing: "border-box",
          padding: "6px 9px",
          lineHeight: 1.6,
          resize: "vertical",
        }}
        focusStyle={inputFocus}
      />
    </Field>
  );
}

/**
 * 저장 버튼 옆의 "저장되지 않은 변경" 표시. 원격 카드는 입력을 초안으로 들고 있다가
 * [저장] 에서 한 번에 보내므로, 고쳐 놓고 다른 카드로 넘어가면 그대로 사라진다 — 그 전에
 * 눈에 띄게 한다.
 */
export function DirtyMark({ dirty }: { dirty: boolean }) {
  if (!dirty) return null;
  return (
    <span style={{ ...HINT, color: "#8f5d17", alignSelf: "center" }}>● 저장되지 않은 변경</span>
  );
}

/** 읽기 전용 값 한 줄(해석된 경로 · 버전). */
export function ReadOnlyRow({ label, value, badge }: { label: string; value: string; badge?: string | null }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
      <span style={{ fontSize: 12.5, fontWeight: 500, flex: "0 0 88px" }}>{label}</span>
      <span
        style={{
          fontFamily: "'Roboto Mono',monospace",
          fontSize: 11.5,
          color: value ? "#4e4a43" : "#a09a8f",
          wordBreak: "break-all",
          flex: 1,
        }}
      >
        {value || "—"}
      </span>
      {badge && (
        <span
          style={{
            fontSize: 11,
            color: "#6a665e",
            background: "#f0ede7",
            borderRadius: 3,
            padding: "1px 6px",
            whiteSpace: "nowrap",
          }}
        >
          {badge}
        </span>
      )}
    </div>
  );
}

/** 연결 상태 점의 색 — 확인 중 · 연결됨 · 안 됨. 탭과 패널이 같은 색을 쓴다. */
export function statusColor(agent: DetectedAgent | null, loading: boolean): string {
  return loading ? "#d9a13b" : agent?.available ? GREEN : "#b5afa2";
}

/**
 * 연결 탭 하나의 본문. 이름과 상태 점은 탭 머리(`AiConnectionsCard`)가 그리므로 여기는 종류
 * 배지 · 상태 한 줄 · 입력 · 진단만 둔다.
 */
export function ConnectionPanel({
  kind,
  agent,
  loading,
  error,
  children,
}: {
  kind: "local" | "remote";
  agent: DetectedAgent | null;
  loading: boolean;
  error?: string;
  children: ReactNode;
}) {
  const ok = !!agent?.available;
  return (
    <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: 11,
            color: "#6a665e",
            background: "#ece8e0",
            borderRadius: 3,
            padding: "1px 5px",
          }}
        >
          {kind === "local" ? "로컬 CLI" : "원격 API"}
        </span>
        <span
          style={{
            ...HINT,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            color: loading ? TEXT.body : ok ? "#256b47" : TEXT.sub,
          }}
        >
          {loading && <AiSignal size={6} color="#8a857c" />}
          {loading ? "확인 중" : ok ? "연결됨" : "연결 안 됨"}
        </span>
      </div>
      {children}
      {!ok && !loading && agent?.diagnostic && (
        <div style={{ ...HINT, color: "#a06a3b" }}>{DIAGNOSTIC_HINT[agent.diagnostic]}</div>
      )}
      {error && <div style={{ ...HINT, color: "#c04a4a" }}>{error}</div>}
    </div>
  );
}

/** 연결 테스트 결과 한 줄. 성공·실패 모두 사유를 그대로 보여 준다. */
export function ProbeLine({ probe }: { probe: { ok: boolean; msg: string } | null }) {
  if (!probe) return null;
  return (
    <div
      style={{
        ...HINT,
        color: probe.ok ? "#3c7d5c" : "#c04a4a",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {probe.msg}
    </div>
  );
}

/**
 * 모델 칩 목록 + 출처 배지. `stagger` 가 바뀌면(연결 테스트를 마쳤다) 칩이 차례로 다시 들어온다 —
 * 처음 그릴 때(0)는 가만히 둔다.
 */
export function Models({ agent, stagger = 0 }: { agent: DetectedAgent | null; stagger?: number }) {
  if (!agent || agent.models.length === 0) {
    return <div style={HINT}>연결하면 사용 가능한 모델이 표시됩니다.</div>;
  }
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, fontWeight: 500 }}>사용 가능한 모델</span>
        <span
          style={{
            fontSize: 11,
            color: "#6a665e",
            background: "#f0ede7",
            borderRadius: 3,
            padding: "1px 6px",
          }}
        >
          {MODELS_SOURCE_LABEL[agent.modelsSource]}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {agent.models.map((m, i) => (
          <span
            key={`${stagger}:${m.id}`}
            title={m.id}
            className={stagger ? "cf-enter" : undefined}
            style={{
              animationDelay: `${Math.min(i, 12) * 35}ms`,
              fontSize: 11.5,
              color: "#4e4a43",
              border: "1px solid #e6e2da",
              borderRadius: 4,
              padding: "2px 7px",
              background: "#fdfcfa",
            }}
          >
            {m.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 단계 줄의 상태 — 도는 중 · 됨 · 안 됨. */
export type StepState = "run" | "ok" | "fail";

/**
 * 단계 한 줄 — 돌기 → 체크(튐) / 빨간 "!". 연결 테스트처럼 여러 단계를 거치는 확인에 쓴다.
 */
export function StepLine({ state, label, detail }: { state: StepState; label: string; detail?: string }) {
  return (
    <div className="cf-enter" style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, lineHeight: 1.6 }}>
      <span style={{ flex: "0 0 16px", height: 20, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {state === "run" ? (
          <Spinner size={11} />
        ) : state === "ok" ? (
          <CheckMark size={11} color={GREEN} />
        ) : (
          <span
            aria-label="실패"
            className="cf-pop"
            style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: "#c04a4a",
              color: "#fff",
              fontSize: 8.5,
              fontWeight: 700,
              lineHeight: "12px",
              textAlign: "center",
            }}
          >
            !
          </span>
        )}
      </span>
      <span style={{ flex: "0 0 auto", fontWeight: 500 }}>{label}</span>
      {detail && (
        <span
          style={{
            ...HINT,
            fontSize: 11.5,
            lineHeight: "20px",
            minWidth: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: state === "fail" ? "#9b4b42" : TEXT.sub,
          }}
        >
          {detail}
        </span>
      )}
    </div>
  );
}

/**
 * 잠깐 떴다 사라지는 확인 — "저장됨 ✓". `n` 이 오를 때마다 다시 뜬다(0 이면 없음). 다 사라지면 내린다.
 */
export function SavedNote({ n, text = "저장됨" }: { n: number; text?: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!n) return;
    setShown(n);
    const t = window.setTimeout(() => setShown((x) => (x === n ? 0 : x)), 3100);
    return () => window.clearTimeout(t);
  }, [n]);
  if (!shown) return null;
  return (
    <span
      key={shown}
      role="status"
      className="cf-chip"
      style={{ ...HINT, alignSelf: "center", color: "#256b47", display: "inline-flex", alignItems: "center", gap: 5 }}
    >
      {text}
      <CheckMark size={10} color={GREEN} />
    </span>
  );
}
