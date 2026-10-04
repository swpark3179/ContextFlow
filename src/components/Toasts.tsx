import { Box } from "../lib/ui";
import { useStore } from "../store/useStore";

/**
 * 화면 오른쪽 아래의 토스트들. 묶음은 눌리지 않는다(`pointerEvents: none`) — 아래의 편집기 ·
 * 단추를 가리지 않게. 단추(`action`)가 있는 토스트만 눌린다. 누르면 무엇을 할지는 스토어가 감싸
 * 두었다(먼저 닫고, 두 번 눌러도 한 번만 — `toast`).
 */
export default function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div
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
        <div
          key={t.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            background: "#2c2a26",
            color: "#f7f5f1",
            borderRadius: 6,
            padding: "9px 13px",
            boxShadow: "0 10px 26px rgba(35,33,30,.28)",
            animation: "tIn .16s ease-out",
            maxWidth: 420,
            ...(t.action && { pointerEvents: "auto" as const }),
          }}
        >
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              flex: "0 0 6px",
              background: t.color,
            }}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500 }}>{t.title}</div>
            {t.sub && (
              <div
                style={{
                  fontFamily: "'Roboto Mono',monospace",
                  fontSize: 10.5,
                  color: "#a8a29a",
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {t.sub}
              </div>
            )}
          </div>
          {t.action && (
            <Box
              onClick={t.action.run}
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
        </div>
      ))}
    </div>
  );
}
