import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Box, EASE_OUT, reducedMotion, useExitSnapshot } from "../lib/ui";
import { TEXT } from "../lib/design";

/** 앞 대화상자의 판 크기 — 이어 받는 대화상자가 그 크기에서 자기 크기로 자란다. */
export interface ModalHandoff {
  width: number;
  height: number;
}

/**
 * Shared overlay + panel chrome for every dialog in the design.
 *
 * 열릴 때는 바탕이 먼저 어두워지고 판이 아래에서 올라온다(`cfPanelIn`, 220ms). 닫힐 때는 그 반대를
 * 짧게 돈다(`useExitSnapshot`) — 대화상자는 스토어 값이 비는 순간 사라지므로 잔상이 대신 나간다.
 * 다른 대화상자로 이어지는 닫힘이면 `exit={false}` 로 잔상을 남기지 않는다.
 *
 * `handoff` 는 그 이어 받는 쪽이다(오늘의 한일 ↔ i-WMS). 바탕은 이미 어두우니 다시 흐려지지 않고, 판은
 * 올라오지 않고 앞 판의 크기에서 제 크기로 280ms 에 걸쳐 자란다 — 한 대화상자가 넓어지는 것처럼 보인다.
 * 열릴 때의 값만 본다.
 */
export function Modal({
  width,
  zIndex = 78,
  onClose,
  children,
  panelStyle,
  exit = true,
  handoff = null,
  panelRef,
}: {
  width: number;
  zIndex?: number;
  onClose: () => void;
  children: ReactNode;
  panelStyle?: CSSProperties;
  exit?: boolean;
  handoff?: ModalHandoff | null;
  /** 판 요소 — 대화상자 안에서 난 키인지 가려야 하는 쪽(`useEscGuard`)이 받는다. */
  panelRef?: RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const own = useRef<HTMLDivElement | null>(null);
  const panel = panelRef ?? own;
  useExitSnapshot(ref, "modal", exit);
  const [from] = useState(handoff);
  const [grown, setGrown] = useState(!from);
  useLayoutEffect(() => {
    if (!from) return;
    if (reducedMotion()) {
      setGrown(true);
      return;
    }
    // 앞 판의 크기로 한 번 잰 뒤에 바꾼다 — 그래야 전환이 그 크기에서 시작한다.
    void panel.current?.offsetWidth;
    const raf = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(raf);
  }, [from]);
  const size: CSSProperties = from && !grown ? { width: from.width, height: from.height } : {};
  return (
    <div
      ref={ref}
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
        animation: from ? "none" : "cfFadeIn 140ms linear",
      }}
    >
      <div
        ref={panel}
        className={from ? "cf-mv" : undefined}
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
          animation: from ? "none" : "cfPanelIn 220ms cubic-bezier(.2,.8,.2,1)",
          ...panelStyle,
          ...(from && { transition: `width 280ms ${EASE_OUT}, height 280ms ${EASE_OUT}` }),
          ...size,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * 한 번에 하나만 도는 제출 — 같은 단추를 두 번 눌러도(또는 Enter 를 누른 채로) 일이 두 번 돌지 않는다.
 * 스토어의 동작에 바쁨 깃발이 없는 대화상자(이름 바꾸기 · 가져오기 · 템플릿 · 병합 · 파일 삭제)가 쓴다.
 * 깃발은 ref 로도 들고 있다 — 상태는 다음 렌더에야 보이므로 같은 틱의 두 번째 누름을 막지 못한다.
 */
export function useSubmit(): [boolean, (fn: () => Promise<unknown>) => Promise<void>] {
  const [busy, setBusy] = useState(false);
  const on = useRef(false);
  const run = async (fn: () => Promise<unknown>) => {
    if (on.current) return;
    on.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      on.current = false;
      setBusy(false);
    }
  };
  return [busy, run];
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

/** 보조 단추. `disabled` 면 눌리지 않고 호버도 없다 — 글자만 흐리게 두면 눌러도 되는 줄 안다. */
export function GhostButton({
  onClick,
  children,
  disabled,
  title,
}: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <Box
      role="button"
      aria-disabled={disabled || undefined}
      title={title}
      onClick={() => !disabled && onClick()}
      style={{
        height: 28,
        padding: "0 13px",
        display: "flex",
        alignItems: "center",
        border: "1px solid #ddd8cf",
        borderRadius: 5,
        background: "#fff",
        fontSize: 12.5,
        color: disabled ? TEXT.off : undefined,
        cursor: disabled ? "default" : "pointer",
      }}
      hover={disabled ? undefined : { background: "#f2efe9" }}
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
        <div style={{ fontSize: 11, color: "#6a665e", marginTop: 2, lineHeight: 1.5 }}>{desc}</div>
      </div>
    </Box>
  );
}

export const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: ".4px",
  color: "#6a665e",
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
