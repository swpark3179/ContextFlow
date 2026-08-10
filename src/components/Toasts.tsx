import { useStore } from "../store/useStore";

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
            <div style={{ fontSize: 11.5, fontWeight: 500 }}>{t.title}</div>
            {t.sub && (
              <div
                style={{
                  fontFamily: "'IBM Plex Mono',monospace",
                  fontSize: 9.5,
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
        </div>
      ))}
    </div>
  );
}
