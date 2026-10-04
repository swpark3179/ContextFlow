import type { CSSProperties, ReactNode } from "react";
import { Box } from "../lib/ui";

/** Shared overlay + panel chrome for every dialog in the design. */
export function Modal({
  width,
  zIndex = 78,
  onClose,
  children,
  panelStyle,
}: {
  width: number;
  zIndex?: number;
  onClose: () => void;
  children: ReactNode;
  panelStyle?: CSSProperties;
}) {
  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(35,33,30,.34)",
        backdropFilter: "blur(1.5px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex,
        animation: "fIn .12s ease-out",
      }}
    >
      <div
        style={{
          width,
          maxWidth: "92vw",
          background: "#fff",
          border: "1px solid #c6c1b6",
          borderRadius: 9,
          boxShadow: "0 30px 70px rgba(35,33,30,.3)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          animation: "pIn .14s ease-out",
          ...panelStyle,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalFooter({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 14px",
        background: "#faf9f6",
        borderTop: "1px solid #e6e2da",
      }}
    >
      {children}
    </div>
  );
}

export function GhostButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Box
      onClick={onClick}
      style={{
        height: 28,
        padding: "0 13px",
        display: "flex",
        alignItems: "center",
        border: "1px solid #ddd8cf",
        borderRadius: 5,
        background: "#fff",
        fontSize: 12.5,
        cursor: "pointer",
      }}
      hover={{ background: "#f2efe9" }}
    >
      {children}
    </Box>
  );
}

/**
 * 주 단추. `busy` 는 눌러 둔 일이 도는 중 — 눌리지 않지만 비활성(회색)이 아니라 진한 바탕을
 * 지킨다. 회색이면 안의 신호 점(`BusyLabel`)이 묻히고 멈춘 단추와 갈리지 않는다. 폭은
 * `minWidth` 로 고정해 글자가 바뀌어도 흔들리지 않는다.
 */
export function PrimaryButton({
  onClick,
  children,
  disabled,
  busy,
  bg = "#3a6fd8",
  hoverBg = "#2f5cbb",
  minWidth,
}: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  bg?: string;
  hoverBg?: string;
  minWidth?: number;
}) {
  const off = disabled && !busy;
  return (
    <Box
      role={busy ? "status" : undefined}
      onClick={() => !disabled && !busy && onClick()}
      style={{
        height: 28,
        minWidth,
        padding: "0 15px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 5,
        fontSize: 12.5,
        fontWeight: 600,
        whiteSpace: "nowrap",
        background: busy ? hoverBg : off ? "#e6e2da" : bg,
        color: off ? "#a09a8f" : "#fff",
        cursor: busy ? "progress" : off ? "not-allowed" : "pointer",
      }}
      hover={disabled || busy ? undefined : { background: hoverBg }}
    >
      {children}
    </Box>
  );
}

/** Radio-style option card used by the import and archive-mode pickers. */
export function OptionCard({
  on,
  label,
  desc,
  onClick,
}: {
  on: boolean;
  label: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <Box
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 9,
        padding: "8px 9px",
        borderRadius: 6,
        cursor: "pointer",
        border: `1px solid ${on ? "#cddcf8" : "#eae6de"}`,
        background: on ? "#f7fafe" : "#fff",
      }}
      hover={{ borderColor: "#c9dbf7" }}
    >
      <div
        style={{
          width: 13,
          height: 13,
          borderRadius: "50%",
          flex: "0 0 13px",
          marginTop: 1,
          border: `1px solid ${on ? "#3a6fd8" : "#cfcabf"}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: on ? "#3a6fd8" : "transparent",
          }}
        />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: on ? 600 : 500, color: "#23211e" }}>{label}</div>
        <div style={{ fontSize: 11, color: "#8a857c", marginTop: 2, lineHeight: 1.5 }}>{desc}</div>
      </div>
    </Box>
  );
}

export const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: ".4px",
  color: "#a09a8f",
  marginBottom: 5,
};

export const inputStyle: CSSProperties = {
  width: "100%",
  height: 29,
  border: "1px solid #ddd8cf",
  borderRadius: 5,
  padding: "0 9px",
  fontSize: 12.5,
  outline: "none",
  color: "#23211e",
  background: "#fff",
};

export const inputFocus: CSSProperties = {
  borderColor: "#3a6fd8",
  boxShadow: "0 0 0 2px #e6eefc",
};
