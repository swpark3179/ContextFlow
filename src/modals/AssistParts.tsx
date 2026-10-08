import type { CSSProperties, ReactNode } from "react";
import type { RouteInfo } from "../store/aiStore";

/** 업무 AI 도우미 팝업(위키 가이드 · 간략 입력 정리 · 이슈 추가)이 함께 쓰는 조각. */

export function AssistHead({ title, task, children }: { title: string; task: string; children?: ReactNode }) {
  return (
    <div
      style={{
        flex: "0 0 40px",
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "0 14px",
        borderBottom: "1px solid #e6e2da",
        background: "#faf9f6",
        minWidth: 0,
      }}
    >
      <span style={{ flex: "0 0 auto", fontSize: 14, fontWeight: 600 }}>{title}</span>
      <span
        title={task}
        style={{
          flex: "0 1 auto",
          minWidth: 0,
          fontSize: 12,
          color: "#8a857c",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {task}
      </span>
      <div style={{ flex: 1 }} />
      {children}
    </div>
  );
}

/** 이 기능이 쓰는 AI 연결 한 줄 — 어느 서비스로 업무 내용이 나가는지 늘 보인다. */
export function RouteLabel({ info }: { info: RouteInfo }) {
  return (
    <span style={{ fontSize: 11, color: "#6a665e", whiteSpace: "nowrap" }}>
      {info.run ? `${info.name} · ${info.modelLabel ?? "기본 모델"}` : "AI 연결 없음"}
      {info.via === "default" ? " (기본 연결)" : ""}
    </span>
  );
}

export function Notice({ tone, children }: { tone: "error" | "warn" | "muted"; children: ReactNode }) {
  const c =
    tone === "error"
      ? { bg: "#fdf3f2", bd: "#f2d6d2", fg: "#9b4b42" }
      : tone === "warn"
        ? { bg: "#fdf8ee", bd: "#f1e2c2", fg: "#8a6420" }
        : { bg: "transparent", bd: "transparent", fg: "#6a665e" };
  return (
    <div
      style={{
        margin: "9px 14px 0 14px",
        padding: "7px 9px",
        borderRadius: 5,
        background: c.bg,
        border: `1px solid ${c.bd}`,
        fontSize: 12,
        color: c.fg,
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {children}
    </div>
  );
}

/** 작은 칩 — 근거 페이지 · 선택지. */
export function chipStyle(on: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height: 22,
    padding: "0 8px",
    borderRadius: 11,
    fontSize: 11.5,
    border: `1px solid ${on ? "#b9cdf3" : "#e3ded4"}`,
    background: on ? "#eef3fd" : "#fff",
    color: on ? "#2f5cbb" : "#4a463f",
    cursor: "pointer",
    whiteSpace: "nowrap",
    maxWidth: 260,
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
}

/** 쓸 곳 고르기의 파일 · 섹션 목록. */
export const selectStyle: CSSProperties = {
  width: "100%",
  height: 28,
  border: "1px solid #ddd8cf",
  borderRadius: 5,
  padding: "0 6px",
  fontSize: 12,
  background: "#fff",
  outline: "none",
  color: "#23211e",
};
