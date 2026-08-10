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
        fontSize: 11.5,
        cursor: "pointer",
      }}
      hover={{ background: "#f2efe9" }}
    >
      {children}
    </Box>
  );
}

export function PrimaryButton({
  onClick,
  children,
  disabled,
  bg = "#3a6fd8",
  hoverBg = "#2f5cbb",
}: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  bg?: string;
  hoverBg?: string;
}) {
  return (
    <Box
      onClick={() => !disabled && onClick()}
      style={{
        height: 28,
        padding: "0 15px",
        display: "flex",
        alignItems: "center",
        borderRadius: 5,
        fontSize: 11.5,
        fontWeight: 600,
        background: disabled ? "#e6e2da" : bg,
        color: disabled ? "#a09a8f" : "#fff",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
      hover={disabled ? undefined : { background: hoverBg }}
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
        <div style={{ fontSize: 11.5, fontWeight: on ? 600 : 500, color: "#23211e" }}>{label}</div>
        <div style={{ fontSize: 10, color: "#8a857c", marginTop: 2, lineHeight: 1.5 }}>{desc}</div>
      </div>
    </Box>
  );
}

export const labelStyle: CSSProperties = {
  fontSize: 10,
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
  fontSize: 11.5,
  outline: "none",
  color: "#23211e",
  background: "#fff",
};

export const inputFocus: CSSProperties = {
  borderColor: "#3a6fd8",
  boxShadow: "0 0 0 2px #e6eefc",
};
