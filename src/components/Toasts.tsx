import { useEffect, useRef, useState } from "react";
import { Box, useExitSnapshot, useFlip } from "../lib/ui";
import { useStore, type Toast } from "../store/useStore";

/**
 * 화면 오른쪽 아래의 토스트들. 묶음은 눌리지 않는다(`pointerEvents: none`) — 아래의 편집기 ·
 * 단추를 가리지 않게. 단추(`action`)가 있거나 실패를 알리는 토스트(`interactive`)만 눌린다.
 * 누르면 무엇을 할지는 스토어가 감싸 두었다(먼저 닫고, 두 번 눌러도 한 번만 — `toast`).
 *
 * 눌리는 토스트는 아래에 남은 시간이 줄어드는 막대가 있고, 마우스를 올린 동안은 멈춘다 — 예전에는
 * 6초가 보이지 않게 흘러 [되돌리기] 를 누르려던 순간 사라졌다. 닫는 것도 이 막대다(스토어의 타이머가
 * 아니다). 사라질 때는 오른쪽으로 빠지고, 남은 토스트는 제자리로 미끄러진다.
 */
export default function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const box = useRef<HTMLDivElement | null>(null);
  useFlip(box, toasts.map((t) => t.id).join(","));
  return (
    <div
      ref={box}
      style={{
        position: "fixed",
        right: 22,
        bottom: 20,
        zIndex: 90,
        display: "flex",
        flexDirection: "column",
        gap: 7,
        alignItems: "flex-end",
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} />
      ))}
    </div>
  );
}

function ToastItem({ t }: { t: Toast }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useExitSnapshot(ref, "toast");
  // 실패 사유는 길다 — 평소에는 한 줄로 자르고, 마우스를 올리면 다 보인다.
  const [open, setOpen] = useState(false);
  const drop = () => useStore.getState().dropToast(t.id);
  // 막대가 움직이지 않는 환경(애니메이션을 끈 웹뷰)에서도 닫히게 — 막대가 시작했으면 그쪽이 닫는다.
  const started = useRef(false);
  useEffect(() => {
    if (!t.interactive) return;
    const timer = window.setTimeout(() => {
      if (!started.current) useStore.getState().dropToast(t.id);
    }, t.ms + 500);
    return () => window.clearTimeout(timer);
  }, [t.id, t.interactive, t.ms]);
  return (
    <div
      ref={ref}
      data-flip={t.id}
      role={t.interactive ? "alert" : "status"}
      className={t.interactive ? "cf-toast" : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 9,
        background: "#2c2a26",
        color: "#f7f5f1",
        borderRadius: 6,
        padding: t.interactive ? "9px 8px 11px 13px" : "9px 13px",
        boxShadow: "0 10px 26px rgba(35,33,30,.28)",
        animation: "tIn .2s cubic-bezier(.2,.8,.2,1)",
        maxWidth: 420,
        overflow: "hidden",
        ...(t.interactive && { pointerEvents: "auto" as const }),
      }}
    >
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          flex: "0 0 7px",
          background: t.color,
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{t.title}</div>
        {t.sub && (
          <div
            style={{
              fontFamily: "'Roboto Mono',monospace",
              fontSize: 11.5,
              color: "#cfc9bf",
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: open && t.interactive ? "normal" : "nowrap",
              wordBreak: open && t.interactive ? "break-all" : undefined,
            }}
          >
            {t.sub}
          </div>
        )}
      </div>
      {t.action && (
        <Box
          onClick={t.action.run}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              t.action?.run();
            }
          }}
          style={{
            flex: "0 0 auto",
            marginLeft: 4,
            fontSize: 11.5,
            fontWeight: 500,
            color: "#9fc0ff",
            border: "1px solid #4a463f",
            borderRadius: 4,
            padding: "3px 8px",
            cursor: "pointer",
            userSelect: "none",
            whiteSpace: "nowrap",
          }}
          hover={{ background: "#3a3731", color: "#c4d8ff" }}
        >
          {t.action.label}
        </Box>
      )}
      {t.interactive && (
        <Box
          onClick={drop}
          role="button"
          tabIndex={0}
          aria-label="알림 닫기"
          title="닫기"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              drop();
            }
          }}
          style={{
            flex: "0 0 auto",
            width: 20,
            height: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 4,
            color: "#a8a29a",
            cursor: "pointer",
          }}
          hover={{ background: "#3a3731", color: "#f7f5f1" }}
        >
          <svg aria-hidden width="8" height="8" viewBox="0 0 8 8">
            <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </Box>
      )}
      {t.interactive && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, background: "#3a3731" }}>
          <div
            className="cf-countdown"
            onAnimationStart={() => (started.current = true)}
            onAnimationEnd={drop}
            style={{ height: 2, background: t.color, animationDuration: `${t.ms}ms` }}
          />
        </div>
      )}
    </div>
  );
}
