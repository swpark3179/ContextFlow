import { getCurrentWindow } from "@tauri-apps/api/window";
import { Box } from "../lib/ui";

/** Custom chrome — the Tauri window runs with `decorations: false`. */
export default function TitleBar({ title }: { title: string }) {
  const win = getCurrentWindow();
  const btn: React.CSSProperties = {
    width: 44,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#5d594f",
    fontSize: 13,
    cursor: "default",
  };

  return (
    <div
      style={{
        height: 34,
        flex: "0 0 34px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 0 0 11px",
        background: "linear-gradient(#f7f5f1,#f1eee9)",
        borderBottom: "1px solid #e0dcd4",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }} data-tauri-drag-region>
        <div
          style={{
            width: 13,
            height: 13,
            borderRadius: 4,
            background: "linear-gradient(140deg,#3a6fd8,#6a54c6)",
          }}
        />
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-.1px" }}>ContextFlow</span>
        <span
          style={{
            fontFamily: "'Roboto Mono',monospace",
            fontSize: 10.5,
            color: "#9b968c",
            border: "1px solid #ded9d0",
            borderRadius: 3,
            padding: "0 4px",
            lineHeight: "15px",
          }}
        >
          v0.3
        </span>
      </div>
      <div
        data-tauri-drag-region
        style={{
          flex: 1,
          textAlign: "center",
          fontSize: 12.5,
          color: "#8a857c",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          alignSelf: "stretch",
          lineHeight: "34px",
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", alignItems: "stretch", height: 34 }}>
        <Box style={btn} hover={{ background: "#e6e2da" }} onClick={() => void win.minimize()}>
          –
        </Box>
        <Box
          style={{ ...btn, fontSize: 11 }}
          hover={{ background: "#e6e2da" }}
          onClick={() => void win.toggleMaximize()}
        >
          ◻
        </Box>
        <Box
          style={{ ...btn, width: 46 }}
          hover={{ background: "#d64545", color: "#fff" }}
          onClick={() => void win.close()}
        >
          ✕
        </Box>
      </div>
    </div>
  );
}
