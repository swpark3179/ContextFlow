/**
 * 설정 화면이 공유하는 껍데기와 위젯.
 *
 * ContextFlow 는 CSS Modules 를 쓰지 않고 전부 인라인 `CSSProperties` 다 — 디자인 HTML 에서
 * 옮겨 온 관례이므로 AI 카드도 같은 방식을 따른다.
 */
import type { CSSProperties, ReactNode } from "react";
import { Box, Input, TextArea } from "../../lib/ui";
import { GREEN } from "../../lib/design";
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
  color: "#8a857c",
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

export function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        flex: "0 0 34px",
        width: 34,
        height: 19,
        borderRadius: 11,
        padding: 2,
        cursor: "pointer",
        background: on ? "#7a5af8" : "#d5d0c6",
        display: "flex",
        justifyContent: on ? "flex-end" : "flex-start",
        transition: "background .15s",
      }}
    >
      <div
        style={{
          width: 15,
          height: 15,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 2px rgba(0,0,0,.2)",
        }}
      />
    </div>
  );
}

/** 버튼. `primary` 는 저장처럼 되돌리기 어려운 동작에만. */
export function Btn({
  label,
  onClick,
  primary,
  disabled,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Box
      onClick={() => {
        if (!disabled) onClick();
      }}
      style={{
        height: 28,
        padding: "0 12px",
        display: "flex",
        alignItems: "center",
        border: `1px solid ${primary ? "#cddcf8" : "#ddd8cf"}`,
        borderRadius: 5,
        background: primary ? "#eef3fd" : "#f7f5f1",
        fontSize: 12.5,
        fontWeight: primary ? 600 : 400,
        color: disabled ? "#b5afa2" : primary ? "#2f5cbb" : "#4e4a43",
        cursor: disabled ? "default" : "pointer",
        whiteSpace: "nowrap",
        opacity: disabled ? 0.6 : 1,
      }}
      hover={disabled ? undefined : { background: primary ? "#e2ebfb" : "#ece8e0" }}
    >
      {label}
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
    <span style={{ ...HINT, color: "#b07520", alignSelf: "center" }}>● 저장되지 않은 변경</span>
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
            fontSize: 10.5,
            color: "#8a857c",
            background: "#ece8e0",
            borderRadius: 3,
            padding: "1px 5px",
          }}
        >
          {kind === "local" ? "로컬 CLI" : "원격 API"}
        </span>
        <span style={{ ...HINT, fontSize: 11, color: ok ? "#3c7d5c" : "#8a857c" }}>
          {loading ? "확인 중…" : ok ? "연결됨" : "연결 안 됨"}
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

/** 모델 칩 목록 + 출처 배지. */
export function Models({ agent }: { agent: DetectedAgent | null }) {
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
        {agent.models.map((m) => (
          <span
            key={m.id}
            title={m.id}
            style={{
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
